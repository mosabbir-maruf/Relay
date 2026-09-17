#!/usr/bin/env python3
"""Self-service Hugging Face -> vLLM preflight for Kaggle dual NVIDIA T4.

This module intentionally uses only Python's standard library. The Hugging Face
Hub API is queried directly with urllib so the preflight step remains portable.
"""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass
from typing import Any, Dict, List, Optional, Tuple

VLLM_VERSION = os.environ.get("VLLM_VERSION", "0.29.0")
DEFAULT_MAX_MODEL_LEN = 4096
DEFAULT_MAX_NUM_SEQS = 4
DEFAULT_GPU_MEMORY_UTILIZATION = 0.85
DEFAULT_TP = 2
DEFAULT_DTYPE = "float16"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8000
TOTAL_T4_VRAM_GB = 30.0

SUPPORTED_CAUSAL_MARKERS = (
    "ForCausalLM",
    "CausalLM",
    "ForConditionalGeneration",
)
UNSUPPORTED_ARCH_MARKERS = (
    "Bert",
    "Albert",
    "Roberta",
    "Deberta",
    "Electra",
    "DistilBert",
    "XLMRoberta",
    "CLIP",
    "Whisper",
    "Speech",
    "Audio",
    "AudioClassification",
    "Wav2Vec",
    "Diffusion",
    "UNet",
)


class PreflightError(RuntimeError):
    pass


@dataclass
class ModelMetadata:
    model_id: str
    model_type: Optional[str]
    architectures: List[str]
    parameter_count: Optional[int]
    quantization: Optional[str]
    quantization_bits: Optional[int]
    torch_dtype: Optional[str]
    context_length: Optional[int]
    gated: bool
    trust_remote_code: bool
    pipeline_tag: Optional[str]


@dataclass
class Hardware:
    gpu_count: int
    gpu_names: List[str]
    compute_capabilities: List[str]
    total_vram_gb: float


def env_value(name: str) -> Optional[str]:
    value = os.environ.get(name)
    if value is None:
        return None
    value = value.strip()
    return value if value else None


def parse_int(value: Optional[str], name: str, minimum: int = 1) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError as exc:
        raise PreflightError(f"{name} must be an integer, got {value!r}.") from exc
    if parsed < minimum:
        raise PreflightError(f"{name} must be >= {minimum}, got {parsed}.")
    return parsed


def parse_float(value: Optional[str], name: str, minimum: float, maximum: float) -> Optional[float]:
    if value is None:
        return None
    try:
        parsed = float(value)
    except ValueError as exc:
        raise PreflightError(f"{name} must be numeric, got {value!r}.") from exc
    if not minimum <= parsed <= maximum:
        raise PreflightError(f"{name} must be between {minimum} and {maximum}, got {parsed}.")
    return parsed


def parse_bool(value: Optional[str], name: str) -> Optional[bool]:
    if value is None:
        return None
    normalized = value.lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise PreflightError(f"{name} must be a boolean (true/false), got {value!r}.")


def auth_token() -> Optional[str]:
    return env_value("HF_TOKEN") or env_value("HUGGINGFACE_HUB_TOKEN")


def http_json(url: str, token: Optional[str] = None) -> Dict[str, Any]:
    headers = {
        "Accept": "application/json",
        "User-Agent": "relay-kaggle-vllm-preflight/1.0",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            raw = response.read()
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise PreflightError(
                "Hugging Face denied access to the model. The repository may be private or gated. "
                "Grant access on Hugging Face and provide HF_TOKEN through a secure environment/Kaggle Secret."
            ) from exc
        if exc.code == 404:
            raise PreflightError("Hugging Face model or config was not found (HTTP 404). Check MODEL_ID.") from exc
        raise PreflightError(f"Hugging Face API request failed with HTTP {exc.code}.") from exc
    except urllib.error.URLError as exc:
        raise PreflightError(f"Unable to reach Hugging Face Hub: {exc.reason}") from exc

    try:
        value = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise PreflightError(f"Hugging Face returned invalid JSON for {url}.") from exc
    if not isinstance(value, dict):
        raise PreflightError(f"Unexpected Hugging Face response shape for {url}.")
    return value


def discover_model(model_id: str, token: Optional[str]) -> ModelMetadata:
    encoded_id = "/".join(urllib.parse_quote(segment, safe="") for segment in model_id.split("/"))
    api = http_json(f"https://huggingface.co/api/models/{encoded_id}", token)

    config: Dict[str, Any] = {}
    try:
        config = http_json(f"https://huggingface.co/{model_id}/resolve/main/config.json", token)
    except PreflightError as exc:
        # Some Hub responses omit config access even when model metadata is public.
        # Keep discovery usable, but surface a warning through the diagnostic layer.
        config = {"_config_error": str(exc)}

    architectures = [str(item) for item in config.get("architectures", []) if item]
    parameter_count = None
    safetensors = api.get("safetensors")
    if isinstance(safetensors, dict):
        value = safetensors.get("parameters")
        if isinstance(value, int):
            parameter_count = value
    if parameter_count is None:
        value = api.get("parameters")
        if isinstance(value, int):
            parameter_count = value

    quant_cfg = config.get("quantization_config")
    quantization = None
    quantization_bits = None
    if isinstance(quant_cfg, dict):
        quantization = (
            quant_cfg.get("quant_method")
            or quant_cfg.get("quantization_method")
            or quant_cfg.get("method")
        )
        bits = quant_cfg.get("bits")
        if isinstance(bits, int):
            quantization_bits = bits
    if quantization is None:
        tags = [str(tag).lower() for tag in api.get("tags", []) if tag]
        for candidate in ("awq", "gptq", "bitsandbytes", "bnb", "int8"):
            if candidate in tags:
                quantization = "bnb_4bit" if candidate == "bnb" else candidate
                break

    context_length = None
    for key in ("max_position_embeddings", "max_sequence_length", "model_max_length", "seq_length"):
        value = config.get(key)
        if isinstance(value, int) and value > 0:
            context_length = value
            break

    torch_dtype = config.get("torch_dtype")
    if not isinstance(torch_dtype, str):
        torch_dtype = None

    gated = bool(api.get("gated")) or bool(api.get("private"))
    auto_map = config.get("auto_map")
    trust_remote_code = bool(auto_map) or bool(config.get("custom_code"))
    pipeline_tag = api.get("pipeline_tag") if isinstance(api.get("pipeline_tag"), str) else None

    return ModelMetadata(
        model_id=model_id,
        model_type=str(config.get("model_type")) if config.get("model_type") else None,
        architectures=architectures,
        parameter_count=parameter_count,
        quantization=str(quantization) if quantization else None,
        quantization_bits=quantization_bits,
        torch_dtype=torch_dtype,
        context_length=context_length,
        gated=gated,
        trust_remote_code=trust_remote_code,
        pipeline_tag=pipeline_tag,
    )


def urllib_parse_quote(value: str, safe: str = "") -> str:
    # Tiny local alias to keep the module dependency-free.
    from urllib.parse import quote

    return quote(value, safe=safe)


# Keep the call site compact and monkeypatch-friendly for tests.
urllib = type("_Urllib", (), {"parse_quote": staticmethod(urllib_parse_quote)})


def query_hardware() -> Hardware:
    try:
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,compute_cap,memory.total",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise PreflightError("nvidia-smi is not available. Enable a Kaggle GPU accelerator.") from exc
    except subprocess.CalledProcessError as exc:
        raise PreflightError("nvidia-smi failed. Verify that NVIDIA drivers/CUDA are available.") from exc

    names: List[str] = []
    caps: List[str] = []
    total_mib = 0.0
    for line in result.stdout.splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 3:
            continue
        names.append(parts[0])
        caps.append(parts[1])
        try:
            total_mib += float(parts[2])
        except ValueError:
            pass
    if not names:
        raise PreflightError("No NVIDIA GPUs detected.")

    return Hardware(
        gpu_count=len(names),
        gpu_names=names,
        compute_capabilities=caps,
        total_vram_gb=total_mib / 1024.0,
    )


def estimate_weight_gb(parameters: Optional[int], quantization: Optional[str], bits: Optional[int]) -> Optional[float]:
    if not parameters:
        return None
    effective_bits = bits
    if effective_bits is None and quantization:
        normalized = quantization.lower()
        if normalized in {"awq", "gptq", "bnb_4bit", "bitsandbytes"}:
            effective_bits = 4
        elif normalized in {"int8", "bnb_8bit"}:
            effective_bits = 8
    bytes_per_param = (effective_bits / 8.0) if effective_bits else 2.0
    # Conservative overhead allowance for scales/metadata/allocator/KV cache.
    return parameters * bytes_per_param * 1.20 / (1024 ** 3)


def resolve_config(metadata: ModelMetadata, hardware: Hardware) -> Dict[str, Any]:
    model_id = env_value("MODEL_ID") or metadata.model_id
    served = env_value("SERVED_MODEL_NAME") or model_id.rsplit("/", 1)[-1].lower().replace("_", "-")

    tp_override = parse_int(env_value("TENSOR_PARALLEL_SIZE"), "TENSOR_PARALLEL_SIZE")
    max_len_override = parse_int(env_value("MAX_MODEL_LEN"), "MAX_MODEL_LEN")
    max_seqs_override = parse_int(env_value("MAX_NUM_SEQS"), "MAX_NUM_SEQS")
    gpu_mem_override = parse_float(env_value("GPU_MEMORY_UTILIZATION"), "GPU_MEMORY_UTILIZATION", 0.5, 0.95)
    dtype_override = env_value("DTYPE")
    quant_override = env_value("QUANTIZATION")
    trust_override = parse_bool(env_value("TRUST_REMOTE_CODE"), "TRUST_REMOTE_CODE")

    dtype = dtype_override or DEFAULT_DTYPE
    if dtype.lower() == "bfloat16":
        raise PreflightError("DTYPE=bfloat16 is rejected on Turing T4. Use float16 instead.")
    if dtype.lower() == "fp8":
        raise PreflightError("DTYPE=fp8 is rejected on Turing T4. Use float16 or a supported quantization mode.")

    quantization = quant_override or metadata.quantization
    if quantization and quantization.lower() in {"fp8", "fp8_e4m3", "fp8_e5m2"}:
        raise PreflightError("FP8 quantization is incompatible with T4 (Turing CC 7.5). Use AWQ/GPTQ/another T4-compatible format.")

    tp = tp_override or DEFAULT_TP
    if tp > hardware.gpu_count:
        raise PreflightError(
            f"TENSOR_PARALLEL_SIZE={tp} exceeds available GPU count ({hardware.gpu_count})."
        )
    if hardware.gpu_count != 2:
        raise PreflightError(
            f"This deployment profile targets dual T4 GPUs, but {hardware.gpu_count} GPU(s) were detected. "
            "Use the existing Qwen profile or explicitly adapt the hardware assumptions before deploying."
        )
    if any("T4" not in name.upper() for name in hardware.gpu_names):
        raise PreflightError(
            "The generic Kaggle profile is constrained to NVIDIA Tesla T4 GPUs. "
            f"Detected: {', '.join(hardware.gpu_names)}."
        )

    max_len = max_len_override or min(metadata.context_length or DEFAULT_MAX_MODEL_LEN, DEFAULT_MAX_MODEL_LEN)
    if max_len < 128:
        raise PreflightError("MAX_MODEL_LEN must be at least 128 tokens for this workflow.")
    max_seqs = max_seqs_override or DEFAULT_MAX_NUM_SEQS
    gpu_mem = gpu_mem_override or DEFAULT_GPU_MEMORY_UTILIZATION
    trust_remote_code = trust_override if trust_override is not None else metadata.trust_remote_code

    estimated_weight_gb = estimate_weight_gb(
        metadata.parameter_count, quantization, metadata.quantization_bits
    )
    if estimated_weight_gb is not None:
        bits = metadata.quantization_bits
        normalized_quant = (quantization or "").lower()
        effective_4bit = bits == 4 or normalized_quant in {"awq", "gptq", "bnb_4bit", "bitsandbytes"}
        if effective_4bit and estimated_weight_gb > 30.0:
            raise PreflightError(
                f"Estimated 4-bit footprint is about {estimated_weight_gb:.1f} GB, exceeding the 30 GB profile. "
                "Choose a smaller model or a stronger quantization.")
        if not effective_4bit and metadata.parameter_count and metadata.parameter_count > 14_000_000_000:
            raise PreflightError(
                "Unquantized models above 14B parameters are rejected for the dual-T4 30 GB profile. "
                "Use a quantized checkpoint or smaller model.")

    return {
        "model_id": model_id,
        "served_model_name": served,
        "tensor_parallel_size": tp,
        "dtype": dtype,
        "quantization": quantization,
        "max_model_len": max_len,
        "max_num_seqs": max_seqs,
        "gpu_memory_utilization": gpu_mem,
        "trust_remote_code": trust_remote_code,
        "host": env_value("VLLM_HOST") or DEFAULT_HOST,
        "port": parse_int(env_value("VLLM_PORT"), "VLLM_PORT") or DEFAULT_PORT,
        "vllm_version": VLLM_VERSION,
        "estimated_weight_gb": estimated_weight_gb,
    }


def validate_architecture(metadata: ModelMetadata) -> None:
    joined = " ".join(metadata.architectures)
    lower = joined.lower()
    for marker in UNSUPPORTED_ARCH_MARKERS:
        if marker.lower() in lower:
            raise PreflightError(
                f"Architecture {joined or metadata.model_type or 'unknown'} is outside the causal-LM deployment profile. "
                "Choose a vLLM-supported text generation / causal model."
            )
    if metadata.pipeline_tag:
        pipeline = metadata.pipeline_tag.lower()
        if any(value in pipeline for value in ("text-classification", "image-classification", "audio", "diffusion", "feature-extraction")):
            raise PreflightError(
                f"Hugging Face pipeline_tag={metadata.pipeline_tag!r} is not a text-generation workload for this workflow."
            )
    if metadata.architectures and not any(marker in joined for marker in SUPPORTED_CAUSAL_MARKERS):
        raise PreflightError(
            f"Could not confirm a causal/conditional generation architecture from {metadata.architectures}. "
            "Choose a vLLM-supported generative model or provide a model-specific profile."
        )


def run(model_id: str) -> Tuple[ModelMetadata, Hardware, Dict[str, Any]]:
    token = auth_token()
    metadata = discover_model(model_id, token)
    validate_architecture(metadata)
    hardware = query_hardware()
    if metadata.gated and not token:
        raise PreflightError(
            "This Hugging Face model is gated/private and no HF_TOKEN is available. "
            "Store a token in a Kaggle Secret named HF_TOKEN and rerun."
        )
    config = resolve_config(metadata, hardware)
    return metadata, hardware, config


def command_argv(config: Dict[str, Any]) -> List[str]:
    argv = [
        "vllm",
        "serve",
        config["model_id"],
        "--served-model-name",
        config["served_model_name"],
        "--tensor-parallel-size",
        str(config["tensor_parallel_size"]),
        "--dtype",
        str(config["dtype"]),
        "--max-model-len",
        str(config["max_model_len"]),
        "--max-num-seqs",
        str(config["max_num_seqs"]),
        "--gpu-memory-utilization",
        str(config["gpu_memory_utilization"]),
        "--host",
        str(config["host"]),
        "--port",
        str(config["port"]),
        "--enforce-eager",
    ]
    if config.get("quantization"):
        argv.extend(["--quantization", str(config["quantization"])])
    if config.get("trust_remote_code"):
        argv.append("--trust-remote-code")
    return argv


def print_human(metadata: ModelMetadata, hardware: Hardware, config: Dict[str, Any]) -> None:
    print("\n=== Relay Kaggle vLLM Preflight ===")
    print(f"Model                : {metadata.model_id}")
    print(f"Architecture         : {', '.join(metadata.architectures) or metadata.model_type or 'unknown'}")
    print(f"Parameters           : {metadata.parameter_count or 'unknown'}")
    print(f"Quantization         : {metadata.quantization or 'none detected'}")
    print(f"Torch dtype          : {metadata.torch_dtype or 'unknown'}")
    print(f"Context length       : {metadata.context_length or 'unknown'}")
    print(f"Gated/private        : {'yes' if metadata.gated else 'no'}")
    print(f"Remote code          : {'yes' if metadata.trust_remote_code else 'no'}")
    print(f"GPU                  : {', '.join(hardware.gpu_names)}")
    print(f"GPU count / VRAM     : {hardware.gpu_count} / {hardware.total_vram_gb:.1f} GB")
    print(f"Tensor parallel      : {config['tensor_parallel_size']}")
    print(f"dtype                : {config['dtype']}")
    print(f"quantization         : {config['quantization'] or 'none'}")
    print(f"max_model_len       : {config['max_model_len']}")
    print(f"max_num_seqs         : {config['max_num_seqs']}")
    print(f"gpu_memory_util      : {config['gpu_memory_utilization']}")
    print(f"estimated weights    : {config['estimated_weight_gb']:.1f} GB" if config['estimated_weight_gb'] else "estimated weights    : unknown")
    print(f"vLLM                 : {config['vllm_version']}")
    print(f"served model         : {config['served_model_name']}")
    print(f"\nvLLM command:\n  {shlex.join(command_argv(config))}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON")
    parser.add_argument("--model-id", default=None, help="Optional MODEL_ID override")
    args = parser.parse_args()

    if args.model_id:
        os.environ["MODEL_ID"] = args.model_id
    model_id = env_value("MODEL_ID")
    if not model_id:
        print("ERROR: MODEL_ID is required.", file=sys.stderr)
        return 2

    try:
        metadata, hardware, config = run(model_id)
    except PreflightError as exc:
        print(f"PREFLIGHT FAILED: {exc}", file=sys.stderr)
        return 1

    payload = {
        "metadata": asdict(metadata),
        "hardware": asdict(hardware),
        "config": config,
        "command": command_argv(config),
        "hf_token_present": bool(auth_token()),
    }
    if args.json:
        print(json.dumps(payload, indent=2, sort_keys=True))
    else:
        print_human(metadata, hardware, config)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
