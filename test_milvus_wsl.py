import subprocess, sys
subprocess.check_call([sys.executable, "-m", "pip", "install", "pymilvus==2.5.10", "-q"])
from pymilvus import MilvusClient
try:
    c = MilvusClient(uri="http://localhost:19530")
    print("WSL连接成功! Collections:", c.list_collections())
except Exception as e:
    print(f"WSL连接失败: {e}")
