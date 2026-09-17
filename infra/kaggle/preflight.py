#!/usr/bin/env python3
"""
Relay Kaggle Infrastructure: Hugging Face & vLLM Preflight Validator

Inspects target Hugging Face models via the official Hub API, validates
compatibility with the Kaggle dual NVIDIA Tesla T4 environment and vLLM,
and resolves safe, deterministic execution parameters.

Configuration Precedence:
  User Overrides -> Model Metadata -> Hardware-Safe Defaults

Compatible with Python 3.8+ (Zero third-party runtime dependencies).
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# Safe hardware defaults for Kaggle dual NVIDIA Tesla T4
DEFAULT_TENSOR_PARALLEL_SIZE = 2
DEFAULT_MAX_MODEL_LEN = 4096
DEFAULT_MAX_NUM_SEQS = 4
DEFAULT_GPU_MEMORY_UTILIZATION = 0.85
DEFAULT_DTYPE = "float16"
DEFAULT_ENFORCE_EAGER = True
DEFAULT_PORT = 8000
DEFAULT_HOST = "0.0.0.0"

# Dual Tesla T4 hardware parameters: 2x 16 GB (~15,109 MiB usable each) = ~30 GB total
DUAL_T4_TOTAL_VRAM_GB = 29.5
DUAL_T4_PER_GPU_VRAM_GB = 14.75

# Unsupported non-causal LM architectures
UNSUPPORTED_ARCH_PATTERNS = [
    r"bert(model|for.*)?$",
    r"roberta(model|for.*)?$",
    r"deberta(model|for.*)?$",
    r"albert(model|for.*)?$",
    r"electra(model|for.*)?$",
    r"clip(model|visionmodel|textmodel)?$",
    r"whisper(forconditionalgeneration)?$",
    r"stablediffusion.*",
    r"diffusion.*",
    r".*forsequenceclassification$",
    r".*fortokenclassification$",
    r".*forquestionanswering$",
    r".*formaskedlm$",
]

# Supported causal LM architecture patterns
SUPPORTED_CAUSAL_PATTERNS = [
    r".*forcausallm$",
    r".*lmheadmodel$",
    r".*forconditionalgeneration$",
    r"llama.*",
    r"qwen.*",
    r"mistral.*",
    r"mixtral.*",
    r"gemma.*",
    r"phi.*",
    r"starcoder.*",
    r"falcon.*",
    r"internlm.*",
    r"deepseek.*",
    r"baichuan.*",
    r"chatglm.*",
    r"decilm.*",
]


def mask_token(token: Optional[str]) -> str:
    """Masks authentication token for safe logging."""
    if not token:
        return "<none>"
    clean = token.strip()
    if len(clean) <= 8:
        return "********"
    return f"{clean[:4]}...{clean[-4:]}"


def sanitize_served_name(model_id: str) -> str:
    """Generates a clean OpenAI-compatible served model alias from HF model ID."""
    name = model_id.split("/")[-1]
    name = re.sub(r"[^a-zA-Z0-9._-]", "-", name).lower()
    return name.strip("-")


def detect_gpus() -> Dict[str, Any]:
    """Detects available NVIDIA GPUs via nvidia-smi."""
    info: Dict[str, Any] = {
        "available": False,
        "count": 0,
        "devices": [],
        "total_vram_gb": 0.0,
        "is_tesla_t4": False,
    }

    if not shutil.which("nvidia-smi"):
        return info

    try:
        cmd = [
            "nvidia-smi",
            "--query-gpu=index,name,memory.total",
            "--format=csv,noheader,nounits",
        ]
        res = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, text=True)
        lines = [line.strip() for line in res.strip().splitlines() if line.strip()]
        info["available"] = len(lines) > 0
        info["count"] = len(lines)

        total_mb = 0.0
        for line in lines:
            parts = [p.strip() for p in line.split(",")]
            idx = int(parts[0]) if len(parts) > 0 else 0
            name = parts[1] if len(parts) > 1 else "Unknown"
            mem_mb = float(parts[2]) if len(parts) > 2 else 0.0
            total_mb += mem_mb
            info["devices"].append({"index": idx, "name": name, "memory_mb": mem_mb})
            if "T4" in name.upper():
                info["is_tesla_t4"] = True

        info["total_vram_gb"] = round(total_mb / 1024.0, 2)
    except Exception:
        pass

    return info


def fetch_hf_model_metadata(
    model_id: str, hf_token: Optional[str] = None
) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """
    Fetches model metadata and config.json from the official Hugging Face Hub API.
    Returns (model_info, config_dict).
    """
    headers = {"User-Agent": "Relay-Kaggle-Preflight/1.0"}
    if hf_token:
        headers["Authorization"] = f"Bearer {hf_token.strip()}"

    # 1. Fetch Model Info
    model_api_url = f"https://huggingface.co/api/models/{model_id}"
    req = urllib.request.Request(model_api_url, headers=headers)

    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            model_info = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            if hf_token:
                raise PermissionError(
                    f"Access denied for model '{model_id}' (HTTP {e.code}). "
                    "Please verify your Hugging Face account has accepted the model's agreement/license."
                ) from e
            raise PermissionError(
                f"Model '{model_id}' is gated or private (HTTP {e.code}). "
                "A Hugging Face access token is required. Set HF_TOKEN in environment or Kaggle Secrets."
            ) from e
        if e.code == 404:
            raise FileNotFoundError(
                f"Model '{model_id}' was not found on Hugging Face Hub (HTTP 404). "
                "Please verify the repository name."
            ) from e
        raise RuntimeError(
            f"Failed to query Hugging Face API for '{model_id}': HTTP {e.code} {e.reason}"
        ) from e
    except urllib.error.URLError as e:
        raise ConnectionError(
            f"Network connection to Hugging Face Hub failed: {e.reason}. "
            "Ensure Internet is enabled in Kaggle notebook settings."
        ) from e

    # 2. Fetch config.json if not present or incomplete in model_info
    config = model_info.get("config")
    if not isinstance(config, dict) or not config.get("architectures"):
        config_url = f"https://huggingface.co/{model_id}/raw/main/config.json"
        cfg_req = urllib.request.Request(config_url, headers=headers)
        try:
            with urllib.request.urlopen(cfg_req, timeout=12) as cfg_resp:
                config = json.loads(cfg_resp.read().decode("utf-8"))
        except Exception:
            if not isinstance(config, dict):
                config = {}

    return model_info, config


def inspect_model_attributes(
    model_info: Dict[str, Any], config: Dict[str, Any]
) -> Dict[str, Any]:
    """Extracts architecture, quantization, context, and size attributes."""
    attrs: Dict[str, Any] = {}

    # Architectures
    architectures = config.get("architectures") or []
    if isinstance(architectures, str):
        architectures = [architectures]
    attrs["architectures"] = architectures
    attrs["model_type"] = config.get("model_type", "")

    # Context length
    ctx = (
        config.get("max_position_embeddings")
        or config.get("seq_length")
        or config.get("max_sequence_length")
        or config.get("n_positions")
    )
    attrs["context_length"] = int(ctx) if ctx and str(ctx).isdigit() else None

    # Native torch dtype
    attrs["torch_dtype"] = config.get("torch_dtype")

    # Quantization detection
    quant_cfg = config.get("quantization_config") or {}
    quant_method = None
    if isinstance(quant_cfg, dict):
        quant_method = quant_cfg.get("quant_method") or quant_cfg.get("quant_type")
    if not quant_method:
        # Check tags or model ID string heuristics as fallback
        tags = model_info.get("tags") or []
        tag_str = " ".join(tags).lower()
        model_id_lower = model_info.get("id", "").lower()
        if "awq" in tag_str or "awq" in model_id_lower:
            quant_method = "awq"
        elif "gptq" in tag_str or "gptq" in model_id_lower:
            quant_method = "gptq"
        elif "fp8" in tag_str or "fp8" in model_id_lower:
            quant_method = "fp8"
        elif "bitsandbytes" in tag_str or "bnb" in model_id_lower:
            quant_method = "bitsandbytes"

    attrs["quantization_method"] = str(quant_method).lower() if quant_method else None

    # Parameter count
    param_count = None
    safetensors = model_info.get("safetensors")
    if isinstance(safetensors, dict) and "total" in safetensors:
        try:
            param_count = int(safetensors["total"])
        except (ValueError, TypeError):
            pass

    if param_count is None:
        # Check num_parameters in config
        n_params = config.get("num_parameters")
        if n_params and str(n_params).isdigit():
            param_count = int(n_params)

    if param_count is None:
        # Heuristic extraction from model ID (e.g. 7b, 30b, 0.5b)
        m = re.search(r"[-_]([0-9]+(?:\.[0-9]+)?)[bB][-_]?", model_info.get("id", ""))
        if m:
            try:
                param_count = int(float(m.group(1)) * 1_000_000_000)
            except ValueError:
                pass

    attrs["param_count"] = param_count

    # Remote code check
    auto_map = config.get("auto_map")
    attrs["requires_remote_code"] = bool(auto_map)

    # Gated check
    attrs["gated"] = bool(model_info.get("gated", False))

    return attrs


def validate_compatibility(
    model_id: str,
    attrs: Dict[str, Any],
    gpu_info: Dict[str, Any],
    user_overrides: Dict[str, Any],
) -> List[str]:
    """
    Validates model compatibility against dual Tesla T4 constraints and vLLM.
    Returns list of fatal error messages (empty if compatible).
    """
    errors: List[str] = []

    archs = attrs.get("architectures", [])
    model_type = attrs.get("model_type", "").lower()
    quant_method = user_overrides.get("quantization") or attrs.get(
        "quantization_method"
    )
    param_count = attrs.get("param_count")

    # 1. Architecture Validation
    has_unsupported = False
    for arch in archs:
        arch_lower = arch.lower()
        if any(re.match(pat, arch_lower) for pat in UNSUPPORTED_ARCH_PATTERNS):
            has_unsupported = True
            break

    if has_unsupported:
        errors.append(
            f"Architecture '{archs}' is not a supported causal language model for vLLM text generation. "
            "Encoder-only, classification, diffusion, vision, and non-text architectures cannot be served."
        )
    else:
        # Check against known supported causal LM architectures
        has_supported = False
        for arch in archs:
            arch_lower = arch.lower()
            if any(re.match(pat, arch_lower) for pat in SUPPORTED_CAUSAL_PATTERNS):
                has_supported = True
                break

        # Fall back to checking model_type against supported patterns
        if not has_supported and model_type:
            if any(re.match(pat, model_type) for pat in SUPPORTED_CAUSAL_PATTERNS):
                has_supported = True

        if not has_supported:
            if archs:
                errors.append(
                    f"Architecture '{archs}' is unrecognized. Unable to verify causal LM compatibility "
                    "with vLLM. To prevent silent deployment failures, automatic preflight fails closed. "
                    "Verify this model is a supported autoregressive causal language model."
                )
            elif not model_type:
                errors.append(
                    f"Model '{model_id}' does not specify architectures or model_type in config.json. "
                    "Unable to verify causal LM compatibility with vLLM."
                )
            else:
                errors.append(
                    f"Model type '{model_type}' is unrecognized. Unable to verify causal LM compatibility with vLLM."
                )

    # 2. Hardware: FP8 Quantization on Tesla T4
    if quant_method == "fp8":
        errors.append(
            "Model uses FP8 quantization. NVIDIA Tesla T4 (Turing, Compute Capability 7.5) does not "
            "possess FP8 tensor cores (FP8 requires Ada Lovelace CC 8.9+ or Hopper CC 9.0+). "
            "Please select an AWQ, GPTQ, or unquantized 16-bit model."
        )

    # 3. Hardware: Tensor Parallel Size vs Available GPUs
    tp_size = user_overrides.get("tensor_parallel_size")
    if tp_size is None:
        tp_size = DEFAULT_TENSOR_PARALLEL_SIZE
    if tp_size <= 0:
        errors.append(f"Invalid tensor_parallel_size ({tp_size}). Must be >= 1.")
    elif gpu_info["available"] and gpu_info["count"] < tp_size:
        errors.append(
            f"Requested tensor_parallel_size ({tp_size}) exceeds detected GPU count ({gpu_info['count']}). "
            "Dual T4 requires 2 GPUs; verify accelerator setting 'GPU T4 x2' in Kaggle."
        )

    # 4. Hardware: VRAM Footprint Estimation (Heuristic Safety Policy)
    if param_count and param_count > 0:
        params_billions = param_count / 1_000_000_000.0

        if not quant_method:
            # Unquantized 16-bit (~2.0 bytes per parameter)
            est_vram_gb = params_billions * 2.0
            if est_vram_gb > DUAL_T4_TOTAL_VRAM_GB:
                errors.append(
                    f"Model parameter count (~{params_billions:.1f}B) in unquantized 16-bit requires "
                    f"~{est_vram_gb:.1f} GB VRAM for weights alone, which exceeds the total usable VRAM "
                    f"of Kaggle dual Tesla T4s (~{DUAL_T4_TOTAL_VRAM_GB:.1f} GB). "
                    "Remediation: Choose an AWQ or GPTQ 4-bit quantized version of this model."
                )
        elif quant_method in ("awq", "gptq"):
            # 4-bit quantization (~0.55-0.65 bytes per parameter)
            est_vram_gb = params_billions * 0.6
            if est_vram_gb > (DUAL_T4_TOTAL_VRAM_GB * 0.85):
                errors.append(
                    f"Quantized 4-bit model (~{params_billions:.1f}B parameters) requires estimated "
                    f"~{est_vram_gb:.1f} GB VRAM, exceeding dual T4 capacity with safety margins. "
                    "Models larger than 32B typically cannot fit on dual Tesla T4s."
                )

    # 5. Context Length Validation
    max_len = user_overrides.get("max_model_len")
    if max_len is None:
        max_len = DEFAULT_MAX_MODEL_LEN
    if max_len < 128:
        errors.append(f"Invalid max_model_len ({max_len}). Must be >= 128.")

    return errors


def resolve_configuration(
    model_id: str,
    attrs: Dict[str, Any],
    user_overrides: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Resolves final vLLM execution arguments using precedence:
      User Overrides -> Model Metadata -> Safe Defaults
    """
    # Served model name
    served_name = (
        user_overrides.get("served_model_name")
        or sanitize_served_name(model_id)
    )

    # Tensor parallel size
    tp = user_overrides.get("tensor_parallel_size")
    if tp is None:
        tp = DEFAULT_TENSOR_PARALLEL_SIZE

    # Quantization
    quant = user_overrides.get("quantization") or attrs.get("quantization_method")
    if quant and quant.lower() in ("none", "null", "false", ""):
        quant = None

    # DType: Tesla T4 must use float16 by default because CC 7.5 lacks hardware bfloat16
    dtype = user_overrides.get("dtype")
    if not dtype:
        dtype = DEFAULT_DTYPE

    # Max Model Length
    native_ctx = attrs.get("context_length")
    max_len = user_overrides.get("max_model_len")
    if max_len is None:
        max_len = DEFAULT_MAX_MODEL_LEN
    if native_ctx and native_ctx < max_len:
        # Bound to native context length if smaller
        max_len = native_ctx

    # Concurrency and GPU memory utilization
    max_seqs = user_overrides.get("max_num_seqs")
    if max_seqs is None:
        max_seqs = DEFAULT_MAX_NUM_SEQS

    gpu_mem = user_overrides.get("gpu_memory_utilization")
    if gpu_mem is None:
        gpu_mem = DEFAULT_GPU_MEMORY_UTILIZATION

    # Enforce eager: T4 benefits heavily from --enforce-eager to avoid CUDA graph VRAM overhead
    enforce_eager = user_overrides.get("enforce_eager")
    if enforce_eager is None:
        enforce_eager = DEFAULT_ENFORCE_EAGER

    # Trust remote code precedence:
    # 1. User override (explicit True/False)
    # 2. Model metadata (requires_remote_code / auto_map in config)
    # 3. Default: False (do not blindly enable when unnecessary)
    trust_remote = user_overrides.get("trust_remote_code")
    if trust_remote is None:
        trust_remote = bool(attrs.get("requires_remote_code", False))

    # Build exact vllm CLI arguments
    cmd_args: List[str] = [
        "vllm",
        "serve",
        model_id,
        "--served-model-name",
        served_name,
        "--host",
        DEFAULT_HOST,
        "--port",
        str(DEFAULT_PORT),
        "--tensor-parallel-size",
        str(tp),
        "--dtype",
        str(dtype),
        "--max-model-len",
        str(max_len),
        "--max-num-seqs",
        str(max_seqs),
        "--gpu-memory-utilization",
        str(gpu_mem),
    ]

    if quant:
        cmd_args.extend(["--quantization", str(quant)])

    if enforce_eager:
        cmd_args.append("--enforce-eager")

    if trust_remote:
        cmd_args.append("--trust-remote-code")

    return {
        "status": "PASS",
        "model_id": model_id,
        "served_model_name": served_name,
        "tensor_parallel_size": tp,
        "dtype": dtype,
        "quantization": quant,
        "max_model_len": max_len,
        "max_num_seqs": max_seqs,
        "gpu_memory_utilization": gpu_mem,
        "enforce_eager": enforce_eager,
        "trust_remote_code": trust_remote,
        "host": DEFAULT_HOST,
        "port": DEFAULT_PORT,
        "command_args": cmd_args,
        "command_str": " ".join(f"'{a}'" if " " in a else a for a in cmd_args),
    }


def print_diagnostic_report(
    model_id: str,
    attrs: Dict[str, Any],
    gpu_info: Dict[str, Any],
    resolved: Dict[str, Any],
    hf_token: Optional[str],
) -> None:
    """Prints a clean human-readable diagnostic report to stderr/stdout."""
    p = sys.stderr.write
    p("\n" + "=" * 64 + "\n")
    p(" RELAY KAGGLE DEPLOYMENT PREFLIGHT REPORT\n")
    p("=" * 64 + "\n")

    p(" [1] Target Hugging Face Model\n")
    p(f"     Model ID:          {model_id}\n")
    p(f"     Architectures:     {attrs.get('architectures') or '<not specified>'}\n")
    p(f"     Model Type:        {attrs.get('model_type') or '<unknown>'}\n")
    param_str = (
        f"{attrs['param_count'] / 1e9:.2f}B"
        if attrs.get("param_count")
        else "Unknown / unlisted"
    )
    p(f"     Parameter Count:   {param_str}\n")
    p(f"     Detected Quant:    {attrs.get('quantization_method') or 'None (16-bit)'}\n")
    p(f"     Config DType:      {attrs.get('torch_dtype') or 'Not specified'}\n")
    p(f"     Context Length:    {attrs.get('context_length') or 'Default'}\n")
    p(f"     Gated Repository:  {'Yes' if attrs.get('gated') else 'No'}\n")
    p(f"     HF Token Status:   {mask_token(hf_token)}\n\n")

    p(" [2] Hardware Environment\n")
    if gpu_info["available"]:
        p(f"     GPU Count:         {gpu_info['count']}\n")
        for dev in gpu_info["devices"]:
            p(f"       - GPU {dev['index']}: {dev['name']} ({dev['memory_mb']:.0f} MiB)\n")
        p(f"     Total VRAM:        {gpu_info['total_vram_gb']} GB\n")
        p(f"     Hardware Class:    {'NVIDIA Tesla T4 (Turing CC 7.5)' if gpu_info['is_tesla_t4'] else 'Custom GPU'}\n\n")
    else:
        p("     GPU Status:        No GPU detected via nvidia-smi (Local/Test mode)\n\n")

    p(" [3] Resolved vLLM Configuration\n")
    p(f"     Served Alias:      {resolved['served_model_name']}\n")
    p(f"     Tensor Parallel:   {resolved['tensor_parallel_size']}\n")
    p(f"     Execution DType:   {resolved['dtype']} (Safe for Turing CC 7.5)\n")
    p(f"     Quantization:      {resolved['quantization'] or 'None'}\n")
    p(f"     Max Model Len:     {resolved['max_model_len']}\n")
    p(f"     Max Num Seqs:      {resolved['max_num_seqs']}\n")
    p(f"     GPU Memory Util:   {resolved['gpu_memory_utilization']}\n")
    p(f"     Enforce Eager:     {resolved['enforce_eager']}\n")
    p(f"     Trust Remote Code: {resolved['trust_remote_code']}\n\n")

    p(" [4] Generated vLLM Execution Command\n")
    p(f"     {resolved['command_str']}\n")
    p("=" * 64 + "\n\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Relay vLLM Preflight & Compatibility Inspector"
    )
    parser.add_argument(
        "--model-id",
        default=os.environ.get("MODEL_ID"),
        help="Target Hugging Face Model ID (e.g., Qwen/Qwen2.5-Coder-7B-Instruct)",
    )
    parser.add_argument(
        "--served-model-name",
        default=os.environ.get("SERVED_MODEL_NAME"),
        help="Served model alias name for OpenAI API routing",
    )
    parser.add_argument(
        "--tensor-parallel-size",
        type=int,
        default=int(os.environ.get("TENSOR_PARALLEL_SIZE", DEFAULT_TENSOR_PARALLEL_SIZE)),
        help="Tensor parallelism degree across GPUs (default: 2)",
    )
    parser.add_argument(
        "--max-model-len",
        type=int,
        default=int(os.environ.get("MAX_MODEL_LEN", DEFAULT_MAX_MODEL_LEN)),
        help="Maximum model context length (default: 4096)",
    )
    parser.add_argument(
        "--max-num-seqs",
        type=int,
        default=int(os.environ.get("MAX_NUM_SEQS", DEFAULT_MAX_NUM_SEQS)),
        help="Maximum number of concurrent sequences (default: 4)",
    )
    parser.add_argument(
        "--gpu-memory-utilization",
        type=float,
        default=float(
            os.environ.get("GPU_MEMORY_UTILIZATION", DEFAULT_GPU_MEMORY_UTILIZATION)
        ),
        help="Fraction of VRAM reserved for vLLM (default: 0.85)",
    )
    parser.add_argument(
        "--dtype",
        default=os.environ.get("DTYPE"),
        help="Precision dtype override (e.g., float16)",
    )
    parser.add_argument(
        "--quantization",
        default=os.environ.get("QUANTIZATION"),
        help="Quantization method override (e.g., awq, gptq)",
    )
    parser.add_argument(
        "--trust-remote-code",
        default=os.environ.get("TRUST_REMOTE_CODE"),
        help="Whether to pass --trust-remote-code (true/false)",
    )
    parser.add_argument(
        "--hf-token",
        default=os.environ.get("HF_TOKEN"),
        help="Hugging Face access token for gated models",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit clean JSON to stdout for programmatic consumption by vllm.sh",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()

    model_id = args.model_id
    if not model_id or not model_id.strip():
        err_msg = "MODEL_ID is required. Provide --model-id or export MODEL_ID in your environment."
        if args.json:
            print(json.dumps({"status": "FAIL", "error": err_msg}))
        else:
            sys.stderr.write(f"PREFLIGHT ERROR: {err_msg}\n")
        sys.exit(1)

    model_id = model_id.strip()

    # User overrides dictionary
    user_overrides: Dict[str, Any] = {
        "served_model_name": args.served_model_name,
        "tensor_parallel_size": args.tensor_parallel_size,
        "max_model_len": args.max_model_len,
        "max_num_seqs": args.max_num_seqs,
        "gpu_memory_utilization": args.gpu_memory_utilization,
        "dtype": args.dtype,
        "quantization": args.quantization,
    }

    if args.trust_remote_code is not None:
        user_overrides["trust_remote_code"] = str(
            args.trust_remote_code
        ).lower() in ("true", "1", "yes")

    # Step 1: Query Hugging Face Hub
    try:
        model_info, config = fetch_hf_model_metadata(model_id, args.hf_token)
    except Exception as e:
        if args.json:
            print(json.dumps({"status": "FAIL", "error": str(e)}))
        else:
            sys.stderr.write(f"\n[PREFLIGHT FAILED] Hugging Face Discovery: {e}\n")
        sys.exit(1)

    # Step 2: Inspect attributes & Detect Hardware
    attrs = inspect_model_attributes(model_info, config)
    gpu_info = detect_gpus()

    # Step 3: Compatibility Validation
    errors = validate_compatibility(model_id, attrs, gpu_info, user_overrides)
    if errors:
        error_summary = " | ".join(errors)
        if args.json:
            print(
                json.dumps(
                    {
                        "status": "FAIL",
                        "error": error_summary,
                        "errors": errors,
                        "model_id": model_id,
                    }
                )
            )
        else:
            sys.stderr.write("\n" + "!" * 64 + "\n")
            sys.stderr.write(" PREFLIGHT COMPATIBILITY VALIDATION FAILED\n")
            sys.stderr.write("!" * 64 + "\n")
            for err in errors:
                sys.stderr.write(f" - {err}\n")
            sys.stderr.write("\nAutomatic deployment halted for safety.\n\n")
        sys.exit(1)

    # Step 4: Resolve Configuration
    resolved = resolve_configuration(model_id, attrs, user_overrides)

    if args.json:
        # Output ONLY JSON to stdout
        print(json.dumps(resolved, indent=2))
    else:
        # Output human diagnostic report
        print_diagnostic_report(model_id, attrs, gpu_info, resolved, args.hf_token)


if __name__ == "__main__":
    main()
