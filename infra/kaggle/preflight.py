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
import shlex
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# Safe reference hardware profile for Kaggle dual NVIDIA Tesla T4
REFERENCE_PER_GPU_VRAM_GB = 14.75
REFERENCE_TOTAL_VRAM_GB = 29.50
DUAL_T4_TOTAL_VRAM_GB = 29.50
DUAL_T4_PER_GPU_VRAM_GB = 14.75

DEFAULT_PORT = 8000
DEFAULT_HOST = "0.0.0.0"

# Deployment policy bounds for GPU memory utilization
POLICY_UTILIZATION_MIN = 0.70
POLICY_UTILIZATION_MAX = 0.92

# Architecture-specific minimum vLLM version requirements (only known requirements)
KNOWN_ARCHITECTURE_MIN_VLLM_VERSIONS: Dict[str, str] = {
    "glmocrforconditionalgeneration": "0.16.0",
    "qwen2vlforconditionalgeneration": "0.20.0",
    "qwen2_5_vlforconditionalgeneration": "0.25.0",
}

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

# Supported multimodal generative architecture patterns
SUPPORTED_MULTIMODAL_ARCH_PATTERNS = [
    r".*glmocr.*",
    r"glm_ocr.*",
    r".*qwen2(_5)?_?vl.*",
    r".*llava.*",
    r".*paligemma.*",
    r".*mllama.*",
    r".*chameleon.*",
]

SUPPORTED_MULTIMODAL_MODEL_TYPES = {
    "glm_ocr",
    "qwen2_vl",
    "qwen2_5_vl",
    "llava",
    "llava_next",
    "paligemma",
    "mllama",
    "chameleon",
}


def parse_semver(ver_str: str) -> Tuple[int, ...]:
    """Parses semantic version string into integer tuple for comparison."""
    parts = []
    for p in re.split(r"[^\d]+", ver_str):
        if p.isdigit():
            parts.append(int(p))
    return tuple(parts) if parts else (0,)


def detect_installed_vllm_version() -> Optional[str]:
    """Detects installed vLLM version via import or CLI. Does not assume presence."""
    try:
        import vllm

        ver = getattr(vllm, "__version__", None)
        if ver:
            return str(ver)
    except Exception:
        pass

    if shutil.which("vllm"):
        try:
            res = subprocess.check_output(
                ["vllm", "--version"], stderr=subprocess.DEVNULL, text=True
            )
            m = re.search(r"([0-9]+\.[0-9]+(?:\.[0-9]+)?)", res)
            if m:
                return m.group(1)
        except Exception:
            pass

    return None


def check_vllm_version_compatibility(
    architectures: List[str], installed_ver: Optional[str]
) -> Dict[str, Any]:
    """
    Checks architecture compatibility against known minimum vLLM versions.
    If architecture has no known minimum in the registry, reports UNKNOWN and requires runtime validation.
    """
    res: Dict[str, Any] = {
        "installed_version": installed_ver or "NOT_INSTALLED",
        "required_version": "UNKNOWN",
        "status": "UNKNOWN_REQUIRES_RUNTIME_CHECK",
        "compatible": True,
        "warning": None,
    }

    if not architectures:
        return res

    for arch in architectures:
        arch_clean = re.sub(r"[^a-zA-Z0-9]", "", arch).lower()
        for req_arch, min_ver in KNOWN_ARCHITECTURE_MIN_VLLM_VERSIONS.items():
            if req_arch in arch_clean:
                res["required_version"] = min_ver
                if installed_ver and installed_ver != "NOT_INSTALLED":
                    if parse_semver(installed_ver) < parse_semver(min_ver):
                        res["compatible"] = False
                        res["status"] = "INCOMPATIBLE"
                        res["warning"] = (
                            f"Architecture '{arch}' requires vLLM >= {min_ver}, but installed "
                            f"version is {installed_ver}."
                        )
                    else:
                        res["status"] = "COMPATIBLE"
                else:
                    res["status"] = "UNVERIFIED_NOT_INSTALLED"
                    res["warning"] = (
                        f"Architecture '{arch}' requires vLLM >= {min_ver}. Ensure vLLM >= {min_ver} "
                        "is installed in the runtime environment."
                    )
                return res

    res["warning"] = (
        "Minimum vLLM version requirement is UNKNOWN for this architecture. "
        "Runtime compatibility validation is required during server startup."
    )
    return res


def classify_model_capabilities(
    architectures: List[str],
    model_type: str,
    config: Dict[str, Any],
) -> Tuple[str, List[str]]:
    """
    Classifies model into (model_kind, modalities).
    Returns:
      model_kind: 'text_causal_lm' | 'multimodal_causal_lm' | 'unsupported'
      modalities: ['text'] | ['text', 'image'] | []
    """
    archs_lower = [a.lower() for a in architectures]
    mt_lower = (model_type or "").lower()

    # 1. Check if explicitly unsupported
    for arch in archs_lower:
        if any(re.match(pat, arch) for pat in UNSUPPORTED_ARCH_PATTERNS):
            return "unsupported", []

    # 2. Check if known supported multimodal architecture
    is_multimodal = False
    for arch in archs_lower:
        if any(re.match(pat, arch) for pat in SUPPORTED_MULTIMODAL_ARCH_PATTERNS):
            is_multimodal = True
            break

    if not is_multimodal and mt_lower in SUPPORTED_MULTIMODAL_MODEL_TYPES:
        is_multimodal = True

    if not is_multimodal:
        # Check if vision configuration or image tokens are present alongside generative architecture
        has_vision = bool(config.get("vision_config") or config.get("image_token_id"))
        has_conditional_gen = any(
            re.match(r".*forconditionalgeneration$", arch) for arch in archs_lower
        )
        if has_vision and (has_conditional_gen or "ocr" in mt_lower or "vl" in mt_lower):
            is_multimodal = True

    if is_multimodal:
        return "multimodal_causal_lm", ["text", "image"]

    # 3. Check if supported text causal LM
    is_causal = False
    for arch in archs_lower:
        if any(re.match(pat, arch) for pat in SUPPORTED_CAUSAL_PATTERNS):
            is_causal = True
            break

    if not is_causal and mt_lower:
        if any(re.match(pat, mt_lower) for pat in SUPPORTED_CAUSAL_PATTERNS):
            is_causal = True

    if is_causal:
        return "text_causal_lm", ["text"]

    return "unsupported", []


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


def resolve_effective_served_model_name(
    user_override: Optional[str] = None,
    model_id: Optional[str] = None,
    resolved_config: Optional[Dict[str, Any]] = None,
    config_path: Optional[str] = None,
    work_dir: Optional[str] = None,
) -> str:
    """
    Resolves the authoritative served model name (OpenAI API alias):
    1. If user explicitly provided an override (non-None, non-empty), use it.
    2. If resolved_config dict is provided and contains 'served_model_name', use it.
    3. If SERVED_MODEL_NAME environment variable is set and non-empty, use it.
    4. If config_path, WORK_DIR/served_model_name.txt, or WORK_DIR/resolved_config.json exists, read from it.
    5. If model_id or MODEL_ID environment variable is available, sanitize it.
    6. Fallback to 'model'.
    """
    if user_override is not None and str(user_override).strip():
        return str(user_override).strip()

    if resolved_config and isinstance(resolved_config, dict):
        cfg_name = resolved_config.get("served_model_name")
        if cfg_name and str(cfg_name).strip():
            return str(cfg_name).strip()

    env_name = os.environ.get("SERVED_MODEL_NAME")
    if env_name and env_name.strip():
        return env_name.strip()

    effective_work_dir = work_dir or os.environ.get("WORK_DIR", "/kaggle/working")
    candidate_paths = []
    if config_path:
        candidate_paths.append(config_path)
    candidate_paths.extend(
        [
            os.path.join(effective_work_dir, "served_model_name.txt"),
            os.path.join(effective_work_dir, "resolved_config.json"),
        ]
    )

    for p in candidate_paths:
        if p and os.path.exists(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                if p.endswith(".json"):
                    data = json.loads(content)
                    n = data.get("served_model_name")
                    if n and str(n).strip():
                        return str(n).strip()
                elif content:
                    return content
            except Exception:
                pass

    mid = model_id or os.environ.get("MODEL_ID")
    if mid and str(mid).strip():
        return sanitize_served_name(str(mid).strip())

    return "model"


def check_has_chat_template(
    tokenizer_config: Optional[Dict[str, Any]],
) -> Tuple[bool, str]:
    """
    Checks if tokenizer_config contains a non-empty, usable chat_template.
    Returns (has_template: bool, description: str).
    """
    if not isinstance(tokenizer_config, dict):
        return False, "tokenizer has no usable chat template"

    ct = tokenizer_config.get("chat_template")
    if ct is None:
        return False, "tokenizer has no usable chat template"

    if isinstance(ct, str):
        cleaned = ct.strip()
        if not cleaned:
            return False, "tokenizer has no usable chat template"
        return True, "tokenizer has valid chat template"

    if isinstance(ct, list):
        valid = any(
            isinstance(item, dict) and bool(str(item.get("template", "")).strip())
            for item in ct
        )
        if valid:
            return True, "tokenizer has valid chat template"
        return False, "tokenizer has no usable chat template"

    return False, "tokenizer has no usable chat template"


def resolve_inference_test_plan(
    model_id: Optional[str] = None,
    target_model: Optional[str] = None,
    hf_token: Optional[str] = None,
    resolved_config: Optional[Dict[str, Any]] = None,
    attrs: Optional[Dict[str, Any]] = None,
    work_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Determines whether to test via /v1/chat/completions or /v1/completions based
    on model kind and tokenizer chat template capability.
    """
    effective_target = target_model or resolve_effective_served_model_name(
        model_id=model_id, resolved_config=resolved_config, work_dir=work_dir
    )

    # 1. Determine model kind
    model_kind = "text_causal_lm"
    if resolved_config and isinstance(resolved_config, dict) and "model_kind" in resolved_config:
        model_kind = resolved_config["model_kind"]
    elif attrs and isinstance(attrs, dict) and "model_kind" in attrs:
        model_kind = attrs["model_kind"]
    elif model_id:
        mid_lower = str(model_id).lower()
        if any(k in mid_lower for k in ["glm-ocr", "ocr", "vl", "vision", "multimodal"]):
            model_kind = "multimodal_causal_lm"

    # 2. Determine chat template capability
    has_chat_template = False
    reason_desc = "tokenizer has no usable chat template"

    if resolved_config and isinstance(resolved_config, dict):
        if "inference_test_plan" in resolved_config and isinstance(resolved_config["inference_test_plan"], dict):
            has_chat_template = resolved_config["inference_test_plan"].get("has_chat_template", False)
            reason_desc = resolved_config["inference_test_plan"].get("reason", reason_desc)
        elif "has_chat_template" in resolved_config:
            has_chat_template = bool(resolved_config["has_chat_template"])
            reason_desc = "tokenizer has valid chat template" if has_chat_template else "tokenizer has no usable chat template"
    elif attrs and isinstance(attrs, dict):
        if "has_chat_template" in attrs:
            has_chat_template = bool(attrs["has_chat_template"])
            reason_desc = "tokenizer has valid chat template" if has_chat_template else "tokenizer has no usable chat template"
        elif "tokenizer_config" in attrs and isinstance(attrs["tokenizer_config"], dict):
            has_chat_template, reason_desc = check_has_chat_template(attrs["tokenizer_config"])

    # If still undetermined and model_id provided, attempt remote check
    if not has_chat_template and model_id and not (attrs and "has_chat_template" in attrs):
        try:
            tok_url = f"https://huggingface.co/{model_id}/raw/main/tokenizer_config.json"
            headers = {"User-Agent": "Relay-Kaggle-Preflight/1.0"}
            if hf_token:
                headers["Authorization"] = f"Bearer {hf_token.strip()}"
            tok_req = urllib.request.Request(tok_url, headers=headers)
            with urllib.request.urlopen(tok_req, timeout=5) as resp:
                tok_cfg = json.loads(resp.read().decode("utf-8"))
                has_chat_template, reason_desc = check_has_chat_template(tok_cfg)
        except Exception:
            has_chat_template = False
            reason_desc = "tokenizer has no usable chat template"

    # 3. Construct test endpoint and payload
    if model_kind == "multimodal_causal_lm":
        data_uri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
        try:
            import test_image  # type: ignore
            data_uri = test_image.generate_test_data_uri()
        except Exception:
            pass

        return {
            "endpoint": "/v1/chat/completions",
            "test_api": "/v1/chat/completions",
            "reason": "multimodal vision/OCR architecture requires chat message format",
            "is_chat": True,
            "is_multimodal": True,
            "has_chat_template": has_chat_template,
            "payload": {
                "model": effective_target,
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "image_url", "image_url": {"url": data_uri}},
                            {"type": "text", "text": "Text Recognition: Extract all text from this image."},
                        ],
                    }
                ],
                "temperature": 0.0,
                "max_tokens": 64,
            },
        }

    if has_chat_template:
        return {
            "endpoint": "/v1/chat/completions",
            "test_api": "/v1/chat/completions",
            "reason": "tokenizer has valid chat template",
            "is_chat": True,
            "is_multimodal": False,
            "has_chat_template": True,
            "payload": {
                "model": effective_target,
                "messages": [
                    {"role": "user", "content": "Reply with only the single word PONG"}
                ],
                "temperature": 0.0,
                "max_tokens": 16,
            },
        }

    # Text causal model without chat template (e.g. GPT-2)
    return {
        "endpoint": "/v1/completions",
        "test_api": "/v1/completions",
        "reason": "tokenizer has no usable chat template",
        "is_chat": False,
        "is_multimodal": False,
        "has_chat_template": False,
        "payload": {
            "model": effective_target,
            "prompt": "Hello, my name is",
            "max_tokens": 20,
            "temperature": 0.0,
        },
    }


def clean_tunnel_url(raw: Optional[str]) -> str:
    """
    Normalizes a tunnel URL into a clean, plain URL string:
    'https://<subdomain>.trycloudflare.com'.
    Strips any Markdown link formatting (e.g., [text](url) or [url]), brackets,
    quotes, whitespace, and trailing paths.
    """
    if not raw or not isinstance(raw, str):
        return ""

    s = raw.strip().strip("'\"`<>")
    # If wrapped in markdown link [text](url) -> extract url
    md_match = re.search(r"\]\((https?://[^\s\)]+)\)", s)
    if md_match:
        s = md_match.group(1).strip()
    else:
        # If [https://...] -> extract inner
        bracket_match = re.search(r"\[(https?://[^\s\]]+)\]", s)
        if bracket_match:
            s = bracket_match.group(1).strip()

    # Match exact trycloudflare subdomain URL
    cf_match = re.search(r"(https?)://([a-zA-Z0-9-]+\.trycloudflare\.com)", s, flags=re.IGNORECASE)
    if cf_match:
        return f"{cf_match.group(1).lower()}://{cf_match.group(2).lower()}"

    # Generic http/https URL
    gen_match = re.search(r"(https?)://([a-zA-Z0-9.-]+(?::[0-9]+)?)", s, flags=re.IGNORECASE)
    if gen_match:
        return f"{gen_match.group(1).lower()}://{gen_match.group(2).lower()}"

    return s.rstrip("/")


_ipv4_fallback_enabled = False

def enable_ipv4_dns_fallback() -> None:
    """
    If default socket.getaddrinfo fails on IPv6/dual-stack queries,
    wraps socket.getaddrinfo to fall back to AF_INET (IPv4).
    """
    global _ipv4_fallback_enabled
    if _ipv4_fallback_enabled:
        return

    orig_getaddrinfo = socket.getaddrinfo

    def patched_getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        try:
            return orig_getaddrinfo(host, port, family, type, proto, flags)
        except socket.gaierror:
            if family == 0:
                # Retry with IPv4 only
                return orig_getaddrinfo(host, port, socket.AF_INET, type, proto, flags)
            raise

    socket.getaddrinfo = patched_getaddrinfo
    _ipv4_fallback_enabled = True


def validate_tunnel_url(url: Optional[str]) -> Tuple[bool, str]:
    """
    Validates that a tunnel URL is well-formed:
    - Non-empty string
    - Scheme is exactly 'https'
    - Hostname is present, non-empty, and contains at least one dot
    - No Markdown brackets, whitespace, or invalid control characters
    - Not localhost, null, or undefined
    Returns (is_valid: bool, error_reason: str).
    """
    if not url or not isinstance(url, str):
        return False, "URL is empty or not a string"

    cleaned = clean_tunnel_url(url)
    if not cleaned:
        return False, "URL is empty after cleaning"

    try:
        parsed = urllib.parse.urlparse(cleaned)
    except Exception as e:
        return False, f"Failed to parse URL: {e}"

    if parsed.scheme.lower() != "https":
        return False, f"Expected https scheme, got: {repr(parsed.scheme)}"

    host = parsed.hostname
    if not host or not host.strip():
        return False, "Hostname is missing or empty"

    host = host.strip()
    if "." not in host:
        return False, f"Hostname '{host}' must contain at least one domain separator dot"

    if any(c in host for c in [" ", "\t", "\r", "\n", "[", "]", "(", ")"]):
        return False, f"Hostname '{host}' contains illegal characters"

    if host.lower() in {"none", "null", "undefined", "localhost", "127.0.0.1"}:
        return False, f"Hostname '{host}' is not a valid public tunnel domain"

    return True, ""


def extract_tunnel_url(
    output_or_text: Optional[str] = None,
    work_dir: Optional[str] = None,
) -> Optional[str]:
    """
    Captures the public Cloudflare Quick Tunnel URL authoritatively.
    Checks in order:
    1. Shell output text (e.g. from cloudflared.sh start / url)
    2. Persisted URL file WORK_DIR/public_tunnel_url.txt
    3. Log file WORK_DIR/cloudflared.log (latest trycloudflare.com match)
    4. Environment variable PUBLIC_TUNNEL_URL or PUBLIC_URL
    Returns the validated, clean https://... URL string, or None.
    """
    candidates: List[str] = []

    if output_or_text and isinstance(output_or_text, str):
        # Match explicit key-values first
        for pattern in [
            r"(?:PUBLIC_TUNNEL_URL|PUBLIC_URL)\s*=\s*([^\s\"']+)",
            r"Public URL:\s*([^\s\"']+)",
            r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)",
        ]:
            matches = re.findall(pattern, output_or_text, flags=re.IGNORECASE)
            for m in reversed(matches):
                candidates.append(m.strip())

    effective_work_dir = work_dir or os.environ.get("WORK_DIR", "/kaggle/working")
    url_file = os.path.join(effective_work_dir, "public_tunnel_url.txt")
    if os.path.exists(url_file):
        try:
            with open(url_file, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if content:
                candidates.append(content)
        except Exception:
            pass

    log_file = os.path.join(effective_work_dir, "cloudflared.log")
    if os.path.exists(log_file):
        try:
            with open(log_file, "r", encoding="utf-8", errors="ignore") as f:
                log_content = f.read()
            matches = re.findall(r"(https://[a-zA-Z0-9-]+\.trycloudflare\.com)", log_content)
            for m in reversed(matches):
                candidates.append(m.strip())
        except Exception:
            pass

    for env_var in ["PUBLIC_TUNNEL_URL", "PUBLIC_URL"]:
        v = os.environ.get(env_var)
        if v and str(v).strip():
            candidates.append(str(v).strip())

    # Check candidates in order and return first valid cleaned URL
    for cand in candidates:
        cleaned = clean_tunnel_url(cand)
        is_valid, _ = validate_tunnel_url(cleaned)
        if is_valid:
            return cleaned

    return None


def resolve_canonical_tunnel_urls(tunnel_url: Optional[str]) -> Dict[str, str]:
    """
    Ensures canonical PUBLIC_TUNNEL_URL and derived BASE_URL:
    BASE_URL is strictly derived from PUBLIC_TUNNEL_URL (f"{PUBLIC_TUNNEL_URL}/v1").
    Raises ValueError if tunnel_url fails validation.
    """
    is_valid, err = validate_tunnel_url(tunnel_url)
    if not is_valid:
        raise ValueError(f"Invalid Cloudflare tunnel URL ({err}): {repr(tunnel_url)}")

    clean_url = clean_tunnel_url(tunnel_url)
    return {
        "public_tunnel_url": clean_url,
        "base_url": f"{clean_url}/v1",
    }


def verify_tunnel_readiness(
    tunnel_url: Optional[str],
    timeout_secs: int = 45,
    poll_interval: float = 2.0,
    target_path: str = "/v1/models",
) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
    """
    Immediately verifies that:
    1. URL is non-empty, scheme is https, hostname is present (via validate_tunnel_url).
       If invalid, aborts IMMEDIATELY without attempting DNS resolution!
    2. Repeatedly polls GET {tunnel_url}{target_path} until HTTP 200 is returned
       or timeout expires (handling DNS propagation delays and 502 gateway warmups).
    Returns (ready: bool, status_or_error_message: str, models_json: Optional[dict]).
    """
    is_valid, err = validate_tunnel_url(tunnel_url)
    if not is_valid:
        return False, f"Pre-validation failed: {err}", None

    clean_url = clean_tunnel_url(tunnel_url)
    test_endpoint = f"{clean_url}{target_path}"
    parsed = urllib.parse.urlparse(clean_url)
    hostname = parsed.hostname or clean_url

    # Check DNS resolution early with IPv4 fallback
    try:
        socket.getaddrinfo(hostname, 443, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        try:
            socket.getaddrinfo(hostname, 443, family=socket.AF_INET, proto=socket.IPPROTO_TCP)
            enable_ipv4_dns_fallback()
        except Exception:
            pass

    start_time = time.time()
    last_err: str = "no attempts made"

    while time.time() - start_time < timeout_secs:
        elapsed = int(time.time() - start_time)
        try:
            req = urllib.request.Request(
                test_endpoint,
                headers={"User-Agent": "Relay-Kaggle-Tunnel-Verifier/1.0"},
            )
            with urllib.request.urlopen(req, timeout=5) as resp:
                if resp.status == 200:
                    raw_body = resp.read().decode("utf-8")
                    try:
                        data = json.loads(raw_body)
                    except Exception:
                        data = {"raw": raw_body}
                    return True, f"Tunnel is responsive and {target_path} returned HTTP 200 in {elapsed}s", data
                else:
                    last_err = f"Endpoint returned HTTP {resp.status}"
        except urllib.error.HTTPError as e:
            last_err = f"HTTP {e.code}: {e.reason}"
        except urllib.error.URLError as e:
            if isinstance(e.reason, socket.gaierror) or "Name or service not known" in str(e.reason) or "nodename nor servname" in str(e.reason):
                last_err = f"DNS lookup pending for {hostname} ({e.reason})"
                # Try IPv4 fallback dynamically
                try:
                    socket.getaddrinfo(hostname, 443, family=socket.AF_INET, proto=socket.IPPROTO_TCP)
                    enable_ipv4_dns_fallback()
                except Exception:
                    pass
            else:
                last_err = f"Connection error: {e.reason}"
        except Exception as e:
            last_err = f"Unexpected error: {e}"

        time.sleep(poll_interval)

    return False, f"Tunnel readiness check timed out after {timeout_secs}s for {test_endpoint}. Last diagnostic: {last_err}", None


def detect_gpus() -> Dict[str, Any]:
    """
    Detects available NVIDIA GPUs via nvidia-smi.
    Does NOT fake hardware in dry-run/local mode.
    """
    info: Dict[str, Any] = {
        "status": "UNKNOWN_NO_GPU",
        "available": False,
        "count": 0,
        "devices": [],
        "total_vram_gb": 0.0,
        "per_gpu_vram_gb": 0.0,
        "is_tesla_t4": False,
        "compute_capability": "Unknown",
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
        if not lines:
            return info

        info["status"] = "DETECTED"
        info["available"] = True
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
                info["compute_capability"] = "7.5"

        info["total_vram_gb"] = round(total_mb / 1024.0, 2)
        info["per_gpu_vram_gb"] = (
            round((total_mb / len(lines)) / 1024.0, 2) if lines else 0.0
        )
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
    has_full_config = (
        isinstance(config, dict)
        and config.get("architectures")
        and (
            config.get("max_position_embeddings")
            or config.get("n_positions")
            or config.get("n_ctx")
            or config.get("hidden_size")
            or config.get("n_embd")
        )
    )
    if not has_full_config:
        config_url = f"https://huggingface.co/{model_id}/raw/main/config.json"
        cfg_req = urllib.request.Request(config_url, headers=headers)
        try:
            with urllib.request.urlopen(cfg_req, timeout=12) as cfg_resp:
                raw_cfg = json.loads(cfg_resp.read().decode("utf-8"))
                if isinstance(raw_cfg, dict):
                    merged = dict(raw_cfg)
                    if isinstance(config, dict):
                        # Merge with config, but don't let empty/stub overwrite full config
                        for k, v in config.items():
                            if v is not None:
                                merged[k] = v
                    config = merged
        except Exception:
            if not isinstance(config, dict):
                config = {}

    # 3. Fetch tokenizer_config.json to inspect chat_template
    tokenizer_config = None
    tok_url = f"https://huggingface.co/{model_id}/raw/main/tokenizer_config.json"
    tok_req = urllib.request.Request(tok_url, headers=headers)
    try:
        with urllib.request.urlopen(tok_req, timeout=8) as tok_resp:
            tokenizer_config = json.loads(tok_resp.read().decode("utf-8"))
    except Exception:
        tokenizer_config = None

    if tokenizer_config is not None:
        model_info["tokenizer_config"] = tokenizer_config

    return model_info, config


def extract_attention_dimensions(config: Dict[str, Any]) -> Dict[str, Any]:
    """
    Extracts attention dimensions needed for formulaic KV cache estimation.
    Checks top-level config and nested text_config (common in vision-language models).
    """
    res: Dict[str, Any] = {
        "num_hidden_layers": None,
        "num_attention_heads": None,
        "num_key_value_heads": None,
        "hidden_size": None,
        "head_dim": None,
        "source": "unknown",
    }

    def _lookup(cfg: Dict[str, Any], keys: List[str]) -> Optional[int]:
        for k in keys:
            v = cfg.get(k)
            if v is not None and str(v).isdigit():
                return int(v)
        return None

    target_cfg = config if isinstance(config, dict) else {}
    text_cfg = (
        target_cfg.get("text_config")
        if isinstance(target_cfg.get("text_config"), dict)
        else {}
    )

    layers = _lookup(
        target_cfg, ["num_hidden_layers", "n_layer", "num_layers", "n_layers"]
    )
    if layers is None:
        layers = _lookup(
            text_cfg, ["num_hidden_layers", "n_layer", "num_layers", "n_layers"]
        )
    res["num_hidden_layers"] = layers

    heads = _lookup(target_cfg, ["num_attention_heads", "n_head", "num_heads"])
    if heads is None:
        heads = _lookup(text_cfg, ["num_attention_heads", "n_head", "num_heads"])
    res["num_attention_heads"] = heads

    kv_heads = _lookup(
        target_cfg, ["num_key_value_heads", "num_kv_heads", "n_head_kv"]
    )
    if kv_heads is None:
        kv_heads = _lookup(
            text_cfg, ["num_key_value_heads", "num_kv_heads", "n_head_kv"]
        )
    if kv_heads is None and heads is not None:
        kv_heads = heads
    res["num_key_value_heads"] = kv_heads

    h_size = _lookup(target_cfg, ["hidden_size", "n_embd", "d_model"])
    if h_size is None:
        h_size = _lookup(text_cfg, ["hidden_size", "n_embd", "d_model"])
    res["hidden_size"] = h_size

    h_dim = _lookup(target_cfg, ["head_dim"])
    if h_dim is None:
        h_dim = _lookup(text_cfg, ["head_dim"])
    if h_dim is None and h_size is not None and heads is not None and heads > 0:
        h_dim = h_size // heads
    res["head_dim"] = h_dim

    if res["num_hidden_layers"] and res["num_key_value_heads"] and res["head_dim"]:
        res["source"] = "hf_config"

    return res


def inspect_model_attributes(
    model_info: Dict[str, Any],
    config: Dict[str, Any],
    tokenizer_config: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Extracts architecture, quantization, context, and size attributes."""
    attrs: Dict[str, Any] = {}
    attrs["raw_config"] = config

    # Architectures
    architectures = config.get("architectures") or []
    if isinstance(architectures, str):
        architectures = [architectures]
    attrs["architectures"] = architectures
    attrs["model_type"] = config.get("model_type", "")

    # Capability classification (text vs multimodal vs unsupported)
    model_kind, modalities = classify_model_capabilities(
        architectures, attrs["model_type"], config
    )
    attrs["model_kind"] = model_kind
    attrs["modalities"] = modalities

    # Context length (check root config and nested text_config for VL/OCR models)
    ctx = (
        config.get("max_position_embeddings")
        or config.get("seq_length")
        or config.get("max_sequence_length")
        or config.get("n_positions")
        or config.get("n_ctx")
    )
    if not ctx and isinstance(config.get("text_config"), dict):
        text_cfg = config["text_config"]
        ctx = (
            text_cfg.get("max_position_embeddings")
            or text_cfg.get("seq_length")
            or text_cfg.get("max_sequence_length")
            or text_cfg.get("n_positions")
            or text_cfg.get("n_ctx")
        )
    attrs["context_length"] = int(ctx) if ctx and str(ctx).isdigit() else None
    attrs["native_context_length"] = attrs["context_length"]

    # Native torch dtype
    torch_dtype = config.get("torch_dtype")
    if not torch_dtype and isinstance(config.get("text_config"), dict):
        torch_dtype = config["text_config"].get("dtype")
    attrs["torch_dtype"] = torch_dtype

    # Attention dimensions for KV cache calculations
    attrs["attention_dimensions"] = extract_attention_dimensions(config)
    attrs["vision_config"] = config.get("vision_config")

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
        # Heuristic extraction from model ID (e.g. 7b, 30b, 0.5b, 0.9b)
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

    # Chat template capability check
    tok_cfg = tokenizer_config or model_info.get("tokenizer_config")
    if tok_cfg is None and isinstance(config, dict) and "tokenizer_config" in config:
        tok_cfg = config.get("tokenizer_config")

    if tok_cfg is not None:
        has_chat_template, chat_template_desc = check_has_chat_template(tok_cfg)
    else:
        if "has_chat_template" in model_info:
            has_chat_template = bool(model_info["has_chat_template"])
            chat_template_desc = (
                "tokenizer has valid chat template"
                if has_chat_template
                else "tokenizer has no usable chat template"
            )
        elif isinstance(config, dict) and "has_chat_template" in config:
            has_chat_template = bool(config["has_chat_template"])
            chat_template_desc = (
                "tokenizer has valid chat template"
                if has_chat_template
                else "tokenizer has no usable chat template"
            )
        else:
            has_chat_template = False
            chat_template_desc = "tokenizer has no usable chat template"

    attrs["has_chat_template"] = has_chat_template
    attrs["chat_template_desc"] = chat_template_desc
    attrs["tokenizer_config"] = tok_cfg

    return attrs


def estimate_memory_components(
    attrs: Dict[str, Any],
    serving_context: int,
    max_num_seqs: int = 1,
) -> Dict[str, Any]:
    """
    Estimates memory components with explicit source, confidence, and warnings.
    Returns:
      weights: {value, unit, source, confidence, warning}
      visual: {value, unit, source, confidence, warning}
      kv_cache: {value, unit, source, confidence, warning}
      cuda_runtime: {value, unit, source, confidence, warning}
      total_estimated_single_gpu_workload_gb: float
    """
    param_count = attrs.get("param_count")
    quant_method = attrs.get("quantization_method")
    model_kind = attrs.get("model_kind", "text_causal_lm")
    attn_dim = attrs.get("attention_dimensions") or {}

    # 1. Weights
    if param_count and param_count > 0:
        if quant_method in ("awq", "gptq"):
            b_per_param = 0.6  # 4-bit + packing overhead
            w_source = f"hf_metadata_{quant_method}_4bit"
        elif quant_method in ("int8", "bitsandbytes"):
            b_per_param = 1.0  # 8-bit
            w_source = f"hf_metadata_{quant_method}_8bit"
        elif quant_method == "fp8":
            b_per_param = 1.0
            w_source = "hf_metadata_fp8"
        else:
            b_per_param = 2.0  # 16-bit
            w_source = "hf_metadata_16bit"

        w_bytes = param_count * b_per_param
        w_val = round(w_bytes / 1e9, 2)
        w_conf = "high"
        w_warn = None
    else:
        w_val = 14.0  # Safe candidate estimate (~7B 16-bit)
        w_source = "heuristic_fallback"
        w_conf = "heuristic"
        w_warn = (
            "Model parameter count is unknown; estimated weight footprint at 14.0 GB "
            "(typical 7B 16-bit)."
        )

    weights_comp = {
        "value": w_val,
        "unit": "GB",
        "source": w_source,
        "confidence": w_conf,
        "warning": w_warn,
    }

    # 2. Visual Encoder Overhead
    if model_kind == "multimodal_causal_lm":
        vision_cfg = attrs.get("vision_config")
        if isinstance(vision_cfg, dict) and vision_cfg.get("num_parameters"):
            v_params = int(vision_cfg["num_parameters"])
            v_val = round((v_params * 2.0) / 1e9, 2)
            v_source = "derived_from_vision_config"
            v_conf = "medium"
            v_warn = None
        else:
            v_val = 1.0
            v_source = "heuristic_estimate"
            v_conf = "heuristic"
            v_warn = (
                "Visual encoder memory is an estimated heuristic (~1.0 GB); actual allocation "
                "depends on vision resolution and tower parameters."
            )
    else:
        v_val = 0.0
        v_source = "not_applicable"
        v_conf = "high"
        v_warn = None

    visual_comp = {
        "value": v_val,
        "unit": "GB",
        "source": v_source,
        "confidence": v_conf,
        "warning": v_warn,
    }

    # 3. KV Cache
    n_layers = attn_dim.get("num_hidden_layers")
    n_kv = attn_dim.get("num_key_value_heads")
    d_h = attn_dim.get("head_dim")

    if n_layers and n_kv and d_h:
        # Formula: 2 (K + V) * layers * kv_heads * head_dim * 2 (float16 bytes) * context * seqs
        kv_bytes = 2 * n_layers * n_kv * d_h * 2 * serving_context * max_num_seqs
        kv_val = round(kv_bytes / (1024**3), 2)
        if kv_val < 0.01:
            kv_val = 0.01
        kv_source = "calculated_from_architecture"
        kv_conf = "high"
        kv_warn = None
    else:
        kv_val = round(1.5 * (serving_context / 4096.0) * max_num_seqs, 2)
        if kv_val < 0.2:
            kv_val = 0.2
        kv_source = "heuristic_estimate"
        kv_conf = "heuristic"
        kv_warn = (
            "KV cache memory estimated via heuristic due to incomplete attention "
            "dimensions in config."
        )

    kv_comp = {
        "value": kv_val,
        "unit": "GB",
        "source": kv_source,
        "confidence": kv_conf,
        "warning": kv_warn,
    }

    # 4. CUDA & Runtime Overhead
    cuda_comp = {
        "value": 1.0,
        "unit": "GB",
        "source": "fixed_runtime_headroom",
        "confidence": "high",
        "warning": None,
    }

    total_single = round(w_val + v_val + kv_val + cuda_comp["value"], 2)

    return {
        "weights": weights_comp,
        "visual": visual_comp,
        "kv_cache": kv_comp,
        "cuda_runtime": cuda_comp,
        "total_estimated_single_gpu_workload_gb": total_single,
    }


def recommend_configuration(
    attrs: Dict[str, Any],
    gpu_info: Dict[str, Any],
    user_overrides: Dict[str, Any],
) -> Dict[str, Any]:
    """
    Executes the strict 7-stage candidate recommendation pipeline:
      Stage 1: Model facts discovery (in attrs)
      Stage 2: Candidate serving context selection
      Stage 3: Memory footprint estimation
      Stage 4: Candidate TP evaluation & fit check
      Stage 5: Utilization calculation vs deployment policy bounds
      Stage 6: vLLM version compatibility check
      Stage 7: Candidate decisions assembly
    """
    model_id = attrs.get("model_id", "")
    model_kind = attrs.get("model_kind", "text_causal_lm")
    modalities = attrs.get("modalities", ["text"])

    # Stage 2: Candidate Serving Context Selection
    native_ctx = attrs.get("context_length")
    user_ctx = user_overrides.get("max_model_len")
    if user_ctx is not None:
        serving_context = int(user_ctx)
        ctx_source = "user_override"
        ctx_rationale = f"User explicitly specified max_model_len={serving_context}."
        ctx_confidence = "high"
        ctx_warning = None
    elif native_ctx is not None and native_ctx > 0:
        serving_context = min(native_ctx, 4096)
        if model_kind == "multimodal_causal_lm":
            serving_context = max(serving_context, 512)
        ctx_source = "bounded_native_context"
        ctx_rationale = (
            f"Bounded native context ({native_ctx}) to min(native_context, 4096) "
            "for stable dual T4 VRAM budget."
        )
        ctx_confidence = "high"
        ctx_warning = None
    else:
        serving_context = 2048
        ctx_source = "safe_candidate_fallback"
        ctx_rationale = (
            "Native model context length is unknown; selected 2048 as safe candidate fallback."
        )
        ctx_confidence = "heuristic"
        ctx_warning = (
            "Native model context length is UNKNOWN in config.json. Using safe candidate "
            "fallback (2048). Verify model context before large-prompt serving."
        )

    # Concurrency (Smoke test default = 1)
    user_seqs = user_overrides.get("max_num_seqs")
    if user_seqs is not None:
        max_num_seqs = int(user_seqs)
        seqs_source = "user_override"
        seqs_rationale = f"User explicitly specified max_num_seqs={max_num_seqs}."
        seqs_confidence = "high"
        seqs_warning = None
    else:
        max_num_seqs = 1
        seqs_source = "smoke_test_default"
        seqs_rationale = (
            "Conservative single-sequence concurrency for initial smoke testing and stable VRAM reservation."
        )
        seqs_confidence = "high"
        seqs_warning = None

    # Stage 3: Memory Footprint Estimation
    mem_est = estimate_memory_components(attrs, serving_context, max_num_seqs)

    # Stage 4: Candidate TP Evaluation & Fit Check
    has_real_gpu = gpu_info.get("available", False)
    if has_real_gpu:
        eval_vram = gpu_info.get("per_gpu_vram_gb", REFERENCE_PER_GPU_VRAM_GB)
        eval_gpus = gpu_info.get("count", 1)
    else:
        eval_vram = REFERENCE_PER_GPU_VRAM_GB
        eval_gpus = 2

    single_workload = mem_est["total_estimated_single_gpu_workload_gb"]
    single_gpu_threshold = round(eval_vram * 0.85, 2)

    user_tp = user_overrides.get("tensor_parallel_size")
    if user_tp is not None:
        rec_tp = int(user_tp)
        tp_source = "user_override"
        tp_rationale = f"User explicitly specified tensor_parallel_size={rec_tp}."
        tp_confidence = "high"
        tp_warning = None
    elif single_workload <= single_gpu_threshold:
        rec_tp = 1
        tp_source = "memory_aware_single_gpu_fit"
        tp_rationale = (
            f"Estimated single-GPU workload ({single_workload:.2f} GB) fits comfortably within "
            f"single GPU VRAM threshold ({single_gpu_threshold:.2f} GB)."
        )
        tp_confidence = (
            "high" if mem_est["weights"]["confidence"] == "high" else "medium"
        )
        tp_warning = None
    elif eval_gpus >= 2:
        rec_tp = 2
        tp_source = "memory_aware_dual_gpu_fit"
        tp_rationale = (
            f"Single-GPU workload ({single_workload:.2f} GB) exceeds single GPU threshold ({single_gpu_threshold:.2f} GB); "
            "workload fits across 2 GPUs with TP=2."
        )
        tp_confidence = (
            "high" if mem_est["weights"]["confidence"] == "high" else "medium"
        )
        tp_warning = None
    else:
        rec_tp = 1
        tp_source = "hardware_constrained"
        tp_rationale = (
            f"Single-GPU workload ({single_workload:.2f} GB) exceeds safe threshold ({single_gpu_threshold:.2f} GB), "
            "but only 1 GPU is available."
        )
        tp_confidence = "medium"
        tp_warning = (
            "Workload exceeds single-GPU safe capacity and only 1 GPU is available."
        )

    # Per-GPU memory breakdown under rec_tp
    attn_dim = attrs.get("attention_dimensions") or {}
    n_kv_heads = attn_dim.get("num_key_value_heads")

    w_per_gpu = round(mem_est["weights"]["value"] / float(rec_tp), 2)
    v_per_gpu = mem_est["visual"]["value"]  # Conservatively replicated under TP=2
    v_sharding_note = (
        "replicated across ranks (conservative assumption)"
        if rec_tp > 1 and v_per_gpu > 0
        else ("single_gpu" if rec_tp == 1 else "not_applicable")
    )

    if rec_tp == 1:
        kv_per_gpu = mem_est["kv_cache"]["value"]
        kv_sharding_note = "single_gpu"
    else:
        if n_kv_heads is not None and n_kv_heads >= rec_tp:
            kv_per_gpu = round(mem_est["kv_cache"]["value"] / float(rec_tp), 2)
            kv_sharding_note = (
                f"sharded across {rec_tp} ranks (num_kv_heads={n_kv_heads} >= {rec_tp})"
            )
        else:
            kv_per_gpu = mem_est["kv_cache"]["value"]
            kv_sharding_note = (
                f"replicated across ranks (num_kv_heads={n_kv_heads} < {rec_tp} or unknown)"
            )

    cuda_per_gpu = mem_est["cuda_runtime"]["value"]

    # Stage 5: Utilization Calculation vs Deployment Policy Bounds
    per_gpu_workload = round(w_per_gpu + v_per_gpu + cuda_per_gpu + kv_per_gpu, 2)
    raw_util = round(per_gpu_workload / eval_vram, 2)
    clamped_util = round(
        min(max(raw_util, POLICY_UTILIZATION_MIN), POLICY_UTILIZATION_MAX), 2
    )

    user_util = user_overrides.get("gpu_memory_utilization")
    if user_util is not None:
        final_util = float(user_util)
        util_source = "user_override"
        util_rationale = (
            f"User explicitly specified gpu_memory_utilization={final_util}."
        )
        util_confidence = "high"
        util_warning = None
    else:
        final_util = clamped_util
        util_source = "calculated_from_memory_requirements"
        util_rationale = (
            f"Calculated from estimated per-GPU memory ({per_gpu_workload:.2f} GB / {eval_vram:.2f} GB = {raw_util:.2f}) "
            f"and clamped to deployment policy bounds [{POLICY_UTILIZATION_MIN:.2f}, {POLICY_UTILIZATION_MAX:.2f}]."
        )
        util_confidence = (
            "high" if mem_est["weights"]["confidence"] == "high" else "medium"
        )
        util_warning = None

    # DType Selection (T4 coercion to float16)
    user_dtype = user_overrides.get("dtype")
    native_dtype = attrs.get("torch_dtype")
    if user_dtype is not None:
        final_dtype = str(user_dtype)
        dtype_source = "user_override"
        dtype_rationale = f"User explicitly specified dtype={final_dtype}."
        dtype_confidence = "high"
        dtype_warning = None
    else:
        final_dtype = "float16"
        if native_dtype and str(native_dtype).lower() in ("bfloat16", "bf16"):
            dtype_source = "t4_hardware_constraint"
            dtype_rationale = (
                "Tesla T4 (Compute Capability 7.5) lacks native bfloat16 execution units; "
                "coerced to float16 for hardware stability."
            )
            dtype_confidence = "high"
            dtype_warning = (
                "Model weights are natively bfloat16. Serving on Tesla T4 downcasts to float16; "
                "verify numeric stability during inference."
            )
        else:
            dtype_source = "hardware_safe_default"
            dtype_rationale = "Safe 16-bit precision default for NVIDIA Tesla T4."
            dtype_confidence = "high"
            dtype_warning = None

    # Quantization
    user_quant = user_overrides.get("quantization")
    native_quant = attrs.get("quantization_method")
    if user_quant is not None:
        if str(user_quant).lower() in ("none", "null", "false", ""):
            final_quant = None
        else:
            final_quant = str(user_quant)
        quant_source = "user_override"
        quant_rationale = f"User explicitly specified quantization={final_quant}."
        quant_confidence = "high"
        quant_warning = None
    else:
        final_quant = native_quant
        quant_source = "hf_model_metadata" if native_quant else "none_detected"
        quant_rationale = (
            f"Detected from Hugging Face repository metadata: {final_quant or 'unquantized 16-bit'}."
        )
        quant_confidence = "high"
        quant_warning = None

    # Trust Remote Code
    user_trc = user_overrides.get("trust_remote_code")
    if user_trc is not None:
        final_trc = bool(user_trc)
        trc_source = "user_override"
        trc_rationale = f"User explicitly specified trust_remote_code={final_trc}."
    else:
        final_trc = bool(attrs.get("requires_remote_code", False))
        trc_source = "hf_config_auto_map" if final_trc else "safe_default_disabled"
        trc_rationale = (
            "Model repository config specifies custom modeling in auto_map."
            if final_trc
            else "Standard supported model architecture; custom remote code disabled for safety."
        )

    # Enforce Eager
    user_ee = user_overrides.get("enforce_eager")
    if user_ee is not None:
        final_ee = bool(user_ee)
        ee_source = "user_override"
        ee_rationale = f"User explicitly specified enforce_eager={final_ee}."
    else:
        final_ee = True
        ee_source = "t4_hardware_policy"
        ee_rationale = (
            "Enforce eager execution to eliminate CUDA graph memory capture overhead on dual T4."
        )

    # Served Model Name
    user_name = user_overrides.get("served_model_name")
    if user_name:
        final_name = str(user_name)
        name_source = "user_override"
    else:
        final_name = sanitize_served_name(model_id or "model")
        name_source = "derived_from_model_id"

    # Extra Args
    extra_args_input = user_overrides.get("extra_vllm_args")
    extra_args: List[str] = []
    if extra_args_input:
        if isinstance(extra_args_input, list):
            extra_args = [str(a) for a in extra_args_input]
        elif isinstance(extra_args_input, str) and extra_args_input.strip():
            extra_args = shlex.split(extra_args_input.strip())

    # Stage 6: vLLM Version Compatibility Check
    vllm_ver = detect_installed_vllm_version()
    vllm_compat = check_vllm_version_compatibility(
        attrs.get("architectures", []), vllm_ver
    )

    # Stage 7: Candidate Decisions Assembly
    decisions = {
        "tensor_parallel_size": {
            "value": rec_tp,
            "source": tp_source,
            "rationale": tp_rationale,
            "confidence": tp_confidence,
            "warning": tp_warning,
        },
        "max_model_len": {
            "value": serving_context,
            "native_context": native_ctx,
            "source": ctx_source,
            "rationale": ctx_rationale,
            "confidence": ctx_confidence,
            "warning": ctx_warning,
        },
        "max_num_seqs": {
            "value": max_num_seqs,
            "source": seqs_source,
            "rationale": seqs_rationale,
            "confidence": seqs_confidence,
            "warning": seqs_warning,
        },
        "gpu_memory_utilization": {
            "value": final_util,
            "raw_calculated": raw_util,
            "policy_clamped": clamped_util,
            "policy_bounds": [POLICY_UTILIZATION_MIN, POLICY_UTILIZATION_MAX],
            "source": util_source,
            "rationale": util_rationale,
            "confidence": util_confidence,
            "warning": util_warning,
        },
        "dtype": {
            "value": final_dtype,
            "native_dtype": native_dtype,
            "source": dtype_source,
            "rationale": dtype_rationale,
            "confidence": dtype_confidence,
            "warning": dtype_warning,
        },
        "quantization": {
            "value": final_quant,
            "source": quant_source,
            "rationale": quant_rationale,
            "confidence": quant_confidence,
            "warning": quant_warning,
        },
        "trust_remote_code": {
            "value": final_trc,
            "source": trc_source,
            "rationale": trc_rationale,
            "confidence": "high",
            "warning": None,
        },
        "enforce_eager": {
            "value": final_ee,
            "source": ee_source,
            "rationale": ee_rationale,
            "confidence": "high",
            "warning": None,
        },
        "served_model_name": {
            "value": final_name,
            "source": name_source,
            "rationale": "OpenAI API alias name.",
            "confidence": "high",
            "warning": None,
        },
    }

    cmd_args: List[str] = [
        "vllm",
        "serve",
        model_id,
        "--served-model-name",
        final_name,
        "--host",
        DEFAULT_HOST,
        "--port",
        str(DEFAULT_PORT),
        "--tensor-parallel-size",
        str(rec_tp),
        "--dtype",
        str(final_dtype),
        "--max-model-len",
        str(serving_context),
        "--max-num-seqs",
        str(max_num_seqs),
        "--gpu-memory-utilization",
        str(final_util),
    ]

    if final_quant:
        cmd_args.extend(["--quantization", str(final_quant)])

    if final_ee:
        cmd_args.append("--enforce-eager")

    if final_trc:
        cmd_args.append("--trust-remote-code")

    if extra_args:
        cmd_args.extend(extra_args)

    test_plan = resolve_inference_test_plan(
        model_id=model_id,
        target_model=final_name,
        attrs=attrs,
    )

    return {
        "status": "CANDIDATE_RECOMMENDED",
        "model_id": model_id,
        "model_kind": model_kind,
        "modalities": modalities,
        "has_chat_template": attrs.get("has_chat_template", False),
        "inference_test_plan": test_plan,
        "served_model_name": final_name,
        "tensor_parallel_size": rec_tp,
        "dtype": final_dtype,
        "quantization": final_quant,
        "max_model_len": serving_context,
        "max_num_seqs": max_num_seqs,
        "gpu_memory_utilization": final_util,
        "enforce_eager": final_ee,
        "trust_remote_code": final_trc,
        "extra_vllm_args": extra_args,
        "host": DEFAULT_HOST,
        "port": DEFAULT_PORT,
        "command_args": cmd_args,
        "command_str": " ".join(f"'{a}'" if " " in a else a for a in cmd_args),
        "vllm_version_check": vllm_compat,
        "memory_breakdown": {
            "estimated_components": mem_est,
            "per_gpu_workload_gb": {
                "weights": w_per_gpu,
                "visual": v_per_gpu,
                "visual_sharding": v_sharding_note,
                "kv_cache": kv_per_gpu,
                "kv_sharding": kv_sharding_note,
                "cuda_runtime": cuda_per_gpu,
                "total": per_gpu_workload,
            },
            "eval_hardware": {
                "per_gpu_vram_gb": eval_vram,
                "gpu_count": eval_gpus,
                "is_simulated_reference": not has_real_gpu,
            },
        },
        "decisions": decisions,
    }


def validate_compatibility(
    model_id: str,
    attrs: Dict[str, Any],
    gpu_info: Dict[str, Any],
    user_overrides: Dict[str, Any],
) -> List[str]:
    """
    Validates model compatibility against hardware constraints, memory budget, and vLLM.
    Returns list of fatal error messages (empty if compatible).
    """
    errors: List[str] = []

    archs = attrs.get("architectures", [])
    model_type = attrs.get("model_type", "").lower()
    quant_method = user_overrides.get("quantization") or attrs.get(
        "quantization_method"
    )
    param_count = attrs.get("param_count")

    # 1. Architecture & Capability Validation
    model_kind = attrs.get("model_kind")
    if not model_kind:
        model_kind, _ = classify_model_capabilities(
            archs, model_type, attrs.get("raw_config") or {}
        )

    if model_kind == "unsupported":
        has_unsupported = False
        for arch in archs:
            if any(re.match(pat, arch.lower()) for pat in UNSUPPORTED_ARCH_PATTERNS):
                has_unsupported = True
                break

        if has_unsupported:
            errors.append(
                f"Architecture '{archs}' is not a supported causal language model or multimodal generative model for vLLM. "
                "Encoder-only, audio, classification, diffusion, and non-generative architectures cannot be served."
            )
        elif archs:
            errors.append(
                f"Architecture '{archs}' is unrecognized. Unable to verify causal LM compatibility or multimodal compatibility "
                "with vLLM. To prevent silent deployment failures, automatic preflight fails closed. "
                "Verify this model is a supported autoregressive causal language or vision-language model."
            )
        elif not model_type:
            errors.append(
                f"Model '{model_id}' does not specify architectures or model_type in config.json. "
                "Unable to verify compatibility with vLLM."
            )
        else:
            errors.append(
                f"Model type '{model_type}' is unrecognized. Unable to verify compatibility with vLLM."
            )

    # 2. Hardware: FP8 Quantization on Tesla T4
    if quant_method == "fp8":
        errors.append(
            "Model uses FP8 quantization. NVIDIA Tesla T4 (Turing, Compute Capability 7.5) does not "
            "possess FP8 tensor cores (FP8 requires Ada Lovelace CC 8.9+ or Hopper CC 9.0+). "
            "Please select an AWQ, GPTQ, or unquantized 16-bit model."
        )

    # 3. vLLM Version Compatibility Check
    installed_vllm = detect_installed_vllm_version()
    vllm_compat = check_vllm_version_compatibility(archs, installed_vllm)
    if not vllm_compat["compatible"]:
        errors.append(vllm_compat["warning"])

    # 4. Hardware: Tensor Parallel Size vs Available GPUs
    tp_size = user_overrides.get("tensor_parallel_size")
    if tp_size is not None:
        if tp_size <= 0:
            errors.append(f"Invalid tensor_parallel_size ({tp_size}). Must be >= 1.")
        elif gpu_info.get("available") and gpu_info.get("count", 0) < tp_size:
            errors.append(
                f"Requested tensor_parallel_size ({tp_size}) exceeds detected GPU count ({gpu_info['count']}). "
                "Dual T4 requires 2 GPUs; verify accelerator setting 'GPU T4 x2' in Kaggle."
            )

    # 5. Hardware: Memory Capacity & Fit Validation
    if param_count and param_count > 0:
        params_billions = param_count / 1_000_000_000.0
        mm_overhead = 1.0 if model_kind == "multimodal_causal_lm" else 0.0

        if quant_method in ("awq", "gptq"):
            b_per_param = 0.6
        elif quant_method in ("int8", "bitsandbytes"):
            b_per_param = 1.0
        elif quant_method == "fp8":
            b_per_param = 1.0
        else:
            b_per_param = 2.0

        weight_gb = params_billions * b_per_param

        has_gpus = gpu_info.get("available", False)
        detected_count = gpu_info.get("count", 0)
        per_gpu_vram = (
            gpu_info.get("per_gpu_vram_gb", REFERENCE_PER_GPU_VRAM_GB)
            if has_gpus
            else REFERENCE_PER_GPU_VRAM_GB
        )

        # Single GPU system constraint or forced TP=1 check
        if (has_gpus and detected_count == 1) or user_overrides.get(
            "tensor_parallel_size"
        ) == 1:
            single_required = weight_gb + mm_overhead + 1.0 + 1.0
            if single_required > (per_gpu_vram * 0.95):
                errors.append(
                    f"Model workload (~{single_required:.1f} GB) exceeds single GPU usable VRAM (~{per_gpu_vram:.1f} GB). "
                    "Dual GPU (TP=2) or 4-bit quantization is required."
                )
        else:
            # Dual GPU evaluation (or reference dual T4)
            dual_per_gpu = (weight_gb / 2.0) + mm_overhead + 1.0 + 1.0
            if dual_per_gpu > (per_gpu_vram * 0.95):
                errors.append(
                    f"Model parameter count (~{params_billions:.1f}B) requires estimated ~{dual_per_gpu:.1f} GB per GPU "
                    f"under TP=2, which exceeds usable capacity of dual Tesla T4s (~{per_gpu_vram:.1f} GB per GPU). "
                    "Remediation: Choose an AWQ or GPTQ 4-bit quantized version of this model."
                )

    # 6. Context Length Validation
    max_len = user_overrides.get("max_model_len")
    if max_len is not None:
        min_allowed_len = 512 if model_kind == "multimodal_causal_lm" else 128
        if max_len < min_allowed_len:
            errors.append(
                f"Invalid max_model_len ({max_len}). Must be >= {min_allowed_len} "
                f"({'multimodal models require sequence budget for visual image tokens and text prompt' if model_kind == 'multimodal_causal_lm' else 'minimum required length'})."
            )

    return errors


def resolve_configuration(
    model_id: str,
    attrs: Dict[str, Any],
    user_overrides: Dict[str, Any],
    gpu_info: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Resolves candidate vLLM configuration using automatic memory-aware recommendation
    with strict user override precedence.
    """
    if gpu_info is None:
        gpu_info = detect_gpus()
    attrs_copy = dict(attrs)
    attrs_copy["model_id"] = model_id
    return recommend_configuration(attrs_copy, gpu_info, user_overrides)


def print_diagnostic_report(
    model_id: str,
    attrs: Dict[str, Any],
    gpu_info: Dict[str, Any],
    resolved: Dict[str, Any],
    hf_token: Optional[str],
) -> None:
    """Prints a clean human-readable diagnostic report with 5 clear sections and advisory notice."""
    p = sys.stderr.write
    p("\n" + "=" * 68 + "\n")
    p(" RELAY KAGGLE DEPLOYMENT PREFLIGHT REPORT\n")
    p("=" * 68 + "\n")

    # Section 1: Target Hugging Face Model Facts
    p(" [1] Discovered Model Facts\n")
    p(f"     Model ID:          {model_id}\n")
    p(f"     Model Kind:        {attrs.get('model_kind') or 'text_causal_lm'}\n")
    p(f"     Modalities:        {', '.join(attrs.get('modalities') or ['text'])}\n")
    p(f"     Architectures:     {attrs.get('architectures') or '<not specified>'}\n")
    p(f"     Model Type:        {attrs.get('model_type') or '<unknown>'}\n")
    param_str = (
        f"{attrs['param_count'] / 1e9:.2f}B"
        if attrs.get("param_count")
        else "Unknown / unlisted"
    )
    p(f"     Parameter Count:   {param_str}\n")
    p(
        f"     Detected Quant:    {attrs.get('quantization_method') or 'None (16-bit)'}\n"
    )
    p(f"     Native DType:      {attrs.get('torch_dtype') or 'Not specified'}\n")
    p(f"     Native Context:    {attrs.get('context_length') or 'Unknown'}\n")
    p(
        f"     Remote Code:       {'Required (auto_map in config)' if attrs.get('requires_remote_code') else 'Disabled (standard)'}\n"
    )
    p(f"     Gated Repository:  {'Yes' if attrs.get('gated') else 'No'}\n")
    p(f"     HF Token Status:   {mask_token(hf_token)}\n")
    has_ct = attrs.get("has_chat_template", False)
    ct_desc = (
        "Available (chat completions supported)"
        if has_ct
        else "None (completions endpoint only)"
    )
    p(f"     Chat Template:     {ct_desc}\n\n")

    # Section 2: Detected Hardware Environment
    p(" [2] Detected Hardware Environment\n")
    status_str = gpu_info.get("status", "UNKNOWN_NO_GPU")
    if gpu_info.get("available"):
        p(f"     Hardware Status:   {status_str}\n")
        p(f"     GPU Count:         {gpu_info['count']}\n")
        for dev in gpu_info["devices"]:
            p(
                f"       - GPU {dev['index']}: {dev['name']} ({dev['memory_mb']:.0f} MiB)\n"
            )
        p(f"     Per-GPU VRAM:      {gpu_info['per_gpu_vram_gb']} GB\n")
        p(f"     Total VRAM:        {gpu_info['total_vram_gb']} GB\n")
        p(
            f"     Hardware Class:    {'NVIDIA Tesla T4 (Turing CC 7.5)' if gpu_info['is_tesla_t4'] else 'Custom GPU'}\n\n"
        )
    else:
        p(
            f"     Hardware Status:   {status_str} (Evaluated against reference dual Tesla T4 profile)\n"
        )
        p(
            f"     Reference Specs:   2x NVIDIA Tesla T4 (~{REFERENCE_PER_GPU_VRAM_GB} GB per GPU, {REFERENCE_TOTAL_VRAM_GB} GB total)\n\n"
        )

    # Section 3: Estimated Memory Footprint
    mem = resolved.get("memory_breakdown", {})
    comps = mem.get("estimated_components", {})
    per_gpu = mem.get("per_gpu_workload_gb", {})
    p(" [3] Estimated Memory Footprint\n")
    if comps:
        w = comps.get("weights", {})
        v = comps.get("visual", {})
        k = comps.get("kv_cache", {})
        c = comps.get("cuda_runtime", {})
        p(
            f"     Weights Memory:    {w.get('value', 0.0):.2f} GB (source: {w.get('source')}, confidence: {w.get('confidence')})\n"
        )
        if w.get("warning"):
            p(f"                        [WARN] {w['warning']}\n")
        p(
            f"     Visual Encoder:    {v.get('value', 0.0):.2f} GB (source: {v.get('source')}, confidence: {v.get('confidence')})\n"
        )
        if v.get("warning"):
            p(f"                        [WARN] {v['warning']}\n")
        p(
            f"     KV Cache Buffer:   {k.get('value', 0.0):.2f} GB (source: {k.get('source')}, confidence: {k.get('confidence')})\n"
        )
        if k.get("warning"):
            p(f"                        [WARN] {k['warning']}\n")
        p(
            f"     CUDA Runtime:      {c.get('value', 0.0):.2f} GB (source: {c.get('source')})\n"
        )
        p(
            f"     Single-GPU Total:  {comps.get('total_estimated_single_gpu_workload_gb', 0.0):.2f} GB\n"
        )
        if per_gpu:
            p(
                f"     Per-GPU Breakdown: {per_gpu.get('total', 0.0):.2f} GB/GPU under TP={resolved.get('tensor_parallel_size')}\n"
            )
            p(
                f"                        (Weights: {per_gpu.get('weights', 0.0):.2f} GB, Visual: {per_gpu.get('visual', 0.0):.2f} GB [{per_gpu.get('visual_sharding')}], KV: {per_gpu.get('kv_cache', 0.0):.2f} GB [{per_gpu.get('kv_sharding')}], CUDA: {per_gpu.get('cuda_runtime', 0.0):.2f} GB)\n"
            )
    p("\n")

    # Section 4: Candidate Deployment Decisions
    decs = resolved.get("decisions", {})
    p(" [4] Candidate Deployment Decisions\n")
    for key, label in [
        ("tensor_parallel_size", "Tensor Parallel"),
        ("max_model_len", "Serving Context"),
        ("max_num_seqs", "Max Num Seqs"),
        ("gpu_memory_utilization", "GPU Memory Util"),
        ("dtype", "Execution DType"),
        ("quantization", "Quantization"),
        ("enforce_eager", "Enforce Eager"),
        ("trust_remote_code", "Trust Remote Code"),
        ("served_model_name", "Served Model Name"),
    ]:
        d = decs.get(key, {})
        val = d.get("value")
        src = d.get("source", "default")
        rat = d.get("rationale")
        warn = d.get("warning")
        p(f"     {label:<18} {str(val):<10} (source: {src})\n")
        if rat:
            p(f"                        Rationale: {rat}\n")
        if warn:
            p(f"                        [WARNING] {warn}\n")
    extra_str = " ".join(resolved.get("extra_vllm_args") or [])
    p(f"     {'Extra vLLM Args':<18} {extra_str if extra_str else 'None'}\n\n")

    # Section 5: Generated vLLM Execution Command
    p(" [5] Generated vLLM Execution Command\n")
    p(f"     {resolved.get('command_str')}\n\n")

    # Section 6: Smoke Test Inference Plan
    plan = resolved.get("inference_test_plan", {})
    if plan:
        p(" [6] Smoke Test Inference Plan\n")
        p(f"     Test API:          {plan.get('test_api')}\n")
        p(f"     Reason:            {plan.get('reason')}\n")
        p(f"     Target Endpoint:   {plan.get('endpoint')}\n\n")

    # Advisory Notice
    p("=" * 68 + "\n")
    p(" ADVISORY NOTICE:\n")
    p(" Preflight establishes CANDIDATE recommendations based on model\n")
    p(" metadata, architecture facts, and memory heuristics.\n")
    p(" Runtime compatibility, CUDA allocation, and inference stability\n")
    p(" must be verified during live server startup in Kaggle.\n")
    p("=" * 68 + "\n\n")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Relay vLLM Preflight & Candidate Recommendation Engine"
    )
    parser.add_argument(
        "--model-id",
        default=os.environ.get("MODEL_ID"),
        help="Target Hugging Face Model ID (e.g., Qwen/Qwen2.5-Coder-7B-Instruct)",
    )
    parser.add_argument(
        "--served-model-name",
        default=os.environ.get("SERVED_MODEL_NAME"),
        help="Served model alias name for OpenAI API routing (default: None, auto-recommended)",
    )

    def _parse_int_env(key: str) -> Optional[int]:
        val = os.environ.get(key)
        if val is not None and val.strip():
            try:
                return int(val.strip())
            except ValueError:
                pass
        return None

    def _parse_float_env(key: str) -> Optional[float]:
        val = os.environ.get(key)
        if val is not None and val.strip():
            try:
                return float(val.strip())
            except ValueError:
                pass
        return None

    parser.add_argument(
        "--tensor-parallel-size",
        type=int,
        default=_parse_int_env("TENSOR_PARALLEL_SIZE"),
        help="Tensor parallelism degree across GPUs (default: None, auto-recommended)",
    )
    parser.add_argument(
        "--max-model-len",
        type=int,
        default=_parse_int_env("MAX_MODEL_LEN"),
        help="Maximum model context length (default: None, auto-recommended)",
    )
    parser.add_argument(
        "--max-num-seqs",
        type=int,
        default=_parse_int_env("MAX_NUM_SEQS"),
        help="Maximum number of concurrent sequences (default: None, auto-recommended)",
    )
    parser.add_argument(
        "--gpu-memory-utilization",
        type=float,
        default=_parse_float_env("GPU_MEMORY_UTILIZATION"),
        help="Fraction of VRAM reserved for vLLM (default: None, auto-calculated [0.70-0.92])",
    )
    parser.add_argument(
        "--dtype",
        default=os.environ.get("DTYPE"),
        help="Precision dtype override (e.g., float16) (default: None, auto-resolved)",
    )
    parser.add_argument(
        "--quantization",
        default=os.environ.get("QUANTIZATION"),
        help="Quantization method override (e.g., awq, gptq) (default: None, auto-detected)",
    )
    parser.add_argument(
        "--trust-remote-code",
        default=os.environ.get("TRUST_REMOTE_CODE"),
        help="Whether to pass --trust-remote-code (true/false) (default: None, auto-resolved)",
    )
    parser.add_argument(
        "--enforce-eager",
        default=os.environ.get("ENFORCE_EAGER"),
        help="Whether to pass --enforce-eager (true/false) (default: None, auto-resolved)",
    )
    parser.add_argument(
        "--extra-vllm-args",
        default=os.environ.get("EXTRA_VLLM_ARGS"),
        help="Additional CLI flags to append to vllm serve",
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
        "extra_vllm_args": args.extra_vllm_args,
    }

    if args.trust_remote_code is not None:
        user_overrides["trust_remote_code"] = str(
            args.trust_remote_code
        ).lower() in ("true", "1", "yes")

    if args.enforce_eager is not None:
        user_overrides["enforce_eager"] = str(
            args.enforce_eager
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
    resolved = resolve_configuration(
        model_id, attrs, user_overrides, gpu_info=gpu_info
    )

    # Persist resolved configuration and alias if output directory is accessible
    work_dir = os.environ.get("WORK_DIR", "/kaggle/working")
    try:
        if not os.path.exists(work_dir):
            os.makedirs(work_dir, exist_ok=True)
        if os.path.isdir(work_dir) and os.access(work_dir, os.W_OK):
            with open(
                os.path.join(work_dir, "resolved_config.json"),
                "w",
                encoding="utf-8",
            ) as f:
                json.dump(resolved, f, indent=2)
            with open(
                os.path.join(work_dir, "served_model_name.txt"),
                "w",
                encoding="utf-8",
            ) as f:
                f.write(str(resolved.get("served_model_name", "")) + "\n")
    except Exception:
        pass

    if args.json:
        # Output ONLY JSON to stdout
        print(json.dumps(resolved, indent=2))
    else:
        # Output human diagnostic report
        print_diagnostic_report(model_id, attrs, gpu_info, resolved, args.hf_token)


if __name__ == "__main__":
    main()
