#!/usr/bin/env python3
"""
Kaggle 2x T4 vLLM Server & Cloudflare Tunnel Runner for Relay.

This script is designed to run in a Kaggle Notebook with 2x NVIDIA T4 GPUs.
It:
1. Verifies the dual T4 GPU environment and VRAM.
2. Installs cloudflared and sets up a public HTTPS tunnel.
3. Launches vLLM with tensor-parallel-size=2, float16 dtype, and AWQ/4-bit quantization for Qwen3-Coder-30B-A3B-Instruct.
4. Waits for the OpenAI-compatible /v1/models endpoint to be healthy.
5. Emits the public URL and exact Relay .env variables.
"""

import os
import re
import subprocess
import sys
import time
import urllib.request
import json

MODEL_ID = os.environ.get("MODEL_ID", "QuantTrio/Qwen3-Coder-30B-A3B-Instruct-AWQ")
PORT = int(os.environ.get("PORT", "8000"))
MAX_MODEL_LEN = int(os.environ.get("MAX_MODEL_LEN", "4096"))
GPU_MEMORY_UTILIZATION = float(os.environ.get("GPU_MEMORY_UTILIZATION", "0.90"))

def check_gpus():
    print("=" * 60)
    print("STEP 1: Checking GPU Environment...")
    print("=" * 60)
    try:
        smi = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name,memory.total,memory.free,driver_version", "--format=csv,noheader"],
            encoding="utf-8"
        ).strip()
        lines = smi.split("\n")
        print(f"Detected {len(lines)} GPU(s):")
        for i, line in enumerate(lines):
            print(f"  GPU {i}: {line}")
        
        if len(lines) < 2:
            print("\n[WARNING] Fewer than 2 GPUs detected. Set accelerator to 'GPU T4 x2' in Kaggle settings.")
    except Exception as e:
        print(f"Error checking nvidia-smi: {e}")

def setup_cloudflared():
    print("\n" + "=" * 60)
    print("STEP 2: Setting up Cloudflare Tunnel...")
    print("=" * 60)
    binary_path = "./cloudflared"
    if not os.path.exists(binary_path):
        print("Downloading cloudflared binary...")
        subprocess.check_call([
            "wget", "-q", "-nc",
            "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
            "-O", binary_path
        ])
        os.chmod(binary_path, 0o755)
    
    log_file = "cloudflared.log"
    if os.path.exists(log_file):
        os.remove(log_file)
        
    print(f"Starting tunnel pointing to http://127.0.0.1:{PORT}...")
    tunnel_proc = subprocess.Popen(
        [binary_path, "tunnel", "--url", f"http://127.0.0.1:{PORT}", "--logfile", log_file],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )
    
    tunnel_url = None
    print("Waiting for Cloudflare Tunnel URL...")
    for _ in range(30):
        time.sleep(1)
        if os.path.exists(log_file):
            with open(log_file, "r") as f:
                content = f.read()
                match = re.search(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com", content)
                if match:
                    tunnel_url = match.group(0)
                    break
                    
    if not tunnel_url:
        print("[ERROR] Failed to obtain Cloudflare Tunnel URL. Check cloudflared.log.")
    else:
        print(f"[SUCCESS] Public Tunnel URL: {tunnel_url}")
        
    return tunnel_proc, tunnel_url

def start_vllm():
    print("\n" + "=" * 60)
    print(f"STEP 3: Launching vLLM with model: {MODEL_ID}...")
    print("=" * 60)
    
    cmd = [
        sys.executable, "-m", "vllm.entrypoints.openai.api_server",
        "--model", MODEL_ID,
        "--host", "0.0.0.0",
        "--port", str(PORT),
        "--tensor-parallel-size", "2",
        "--dtype", "float16",  # NVIDIA T4 does not support bfloat16
        "--max-model-len", str(MAX_MODEL_LEN),
        "--gpu-memory-utilization", str(GPU_MEMORY_UTILIZATION),
        "--trust-remote-code",
        "--enforce-eager",     # Recommended on T4 to avoid CUDA graph memory overhead
    ]
    
    print("Running command:")
    print(" ".join(cmd))
    
    log_file = open("vllm_server.log", "w")
    vllm_proc = subprocess.Popen(cmd, stdout=log_file, stderr=subprocess.STDOUT)
    return vllm_proc

def wait_for_health():
    print("\n" + "=" * 60)
    print("STEP 4: Waiting for vLLM server to become healthy...")
    print("=" * 60)
    health_url = f"http://127.0.0.1:{PORT}/v1/models"
    
    for i in range(180):
        time.sleep(2)
        try:
            req = urllib.request.Request(health_url)
            with urllib.request.urlopen(req, timeout=2) as response:
                if response.status == 200:
                    data = json.loads(response.read().decode())
                    print(f"\n[SUCCESS] vLLM is online and healthy!")
                    print(f"Available models: {[m['id'] for m in data.get('data', [])]}")
                    return True
        except Exception:
            if i % 10 == 0:
                print(f"Waiting for model initialization... ({i * 2}s elapsed)")
                
    print("\n[ERROR] vLLM server did not become healthy in time. Check vllm_server.log.")
    return False

def verify_chat(tunnel_url):
    print("\n" + "=" * 60)
    print("STEP 5: Verifying chat completions through Cloudflare Tunnel...")
    print("=" * 60)
    
    chat_url = f"{tunnel_url}/v1/chat/completions"
    payload = {
        "model": MODEL_ID,
        "messages": [{"role": "user", "content": "Reply with only the word PONG"}],
        "temperature": 0.0,
        "max_tokens": 10
    }
    
    try:
        req = urllib.request.Request(
            chat_url,
            data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json"}
        )
        with urllib.request.urlopen(req, timeout=30) as response:
            res_body = json.loads(response.read().decode())
            print("[SUCCESS] Live chat completion response:")
            print(json.dumps(res_body, indent=2))
    except Exception as e:
        print(f"[ERROR] Live verification request failed: {e}")

def main():
    check_gpus()
    tunnel_proc, tunnel_url = setup_cloudflared()
    if not tunnel_url:
        return
        
    vllm_proc = start_vllm()
    is_healthy = wait_for_health()
    
    if is_healthy:
        verify_chat(tunnel_url)
        print("\n" + "=" * 60)
        print("CONGRATULATIONS! Your Kaggle vLLM Backend is LIVE.")
        print("=" * 60)
        print("Add these variables to your local Relay .env file:")
        print(f"OPENAI_COMPATIBLE_BASE_URL={tunnel_url}/v1")
        print(f"OPENAI_COMPATIBLE_API_KEY=")
        print(f"OPENAI_COMPATIBLE_MODELS={MODEL_ID}")
        print(f"OPENAI_COMPATIBLE_NAME=vllm-qwen")
        print("=" * 60)
        
    try:
        vllm_proc.wait()
    except KeyboardInterrupt:
        print("\nShutting down servers...")
        vllm_proc.terminate()
        tunnel_proc.terminate()

if __name__ == "__main__":
    main()
