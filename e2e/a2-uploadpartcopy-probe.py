"""★A2 的决定性实验★：Garage 支不支持 UploadPartCopy（服务端分片复制）。

不需要 5 GiB 的对象 —— 要验的是**这条码路**，不是 Garage 的天花板在哪。
S3 的最小分片正好是 5 MiB，用一个 12 MiB 的对象跑 3 个分片，
走的逻辑与 50 GB 完全相同：通了就是通了。
"""
import hashlib, os, boto3
from botocore.config import Config

ep  = os.environ["EP"]; bkt = os.environ["S3_BUCKET"]
s3 = boto3.client("s3", endpoint_url=ep, region_name=os.environ.get("S3_REGION", "garage"),
                  config=Config(s3={"addressing_style": "path"}, retries={"max_attempts": 2}))

SRC, DST = "audit/a2-src", "audit/a2-dst"
PART = 5 * 1024 * 1024                      # S3 最小分片
body = bytes(os.urandom(12 * 1024 * 1024))  # 12 MiB → 3 个分片(5+5+2)
src_sha = hashlib.sha256(body).hexdigest()
print(f"源对象 {len(body)/1048576:.0f} MiB  sha={src_sha[:12]}")

s3.put_object(Bucket=bkt, Key=SRC, Body=body)
print("① put_object 成功")

# —— 先试普通 CopyObject(小对象必成功,确认基线) ——
s3.copy_object(Bucket=bkt, Key=DST + "-plain", CopySource=f"{bkt}/{SRC}")
print("② CopyObject(单次)成功 —— 小对象这条路是通的")

# —— 核心:UploadPartCopy ——
up = s3.create_multipart_upload(Bucket=bkt, Key=DST)["UploadId"]
parts, off, n = [], 0, 0
try:
    while off < len(body):
        end = min(off + PART, len(body)) - 1
        n += 1
        r = s3.upload_part_copy(Bucket=bkt, Key=DST, UploadId=up, PartNumber=n,
                                CopySource=f"{bkt}/{SRC}", CopySourceRange=f"bytes={off}-{end}")
        parts.append({"ETag": r["CopyPartResult"]["ETag"], "PartNumber": n})
        print(f"   ③ UploadPartCopy 第 {n} 片 bytes={off}-{end} ok")
        off = end + 1
    s3.complete_multipart_upload(Bucket=bkt, Key=DST, UploadId=up,
                                 MultipartUpload={"Parts": parts})
    print(f"④ complete 成功,{n} 个分片")
except Exception as e:
    s3.abort_multipart_upload(Bucket=bkt, Key=DST, UploadId=up)
    print(f"★UploadPartCopy 失败★: {type(e).__name__}: {e}")
    raise SystemExit(1)

got = s3.get_object(Bucket=bkt, Key=DST)["Body"].read()
dst_sha = hashlib.sha256(got).hexdigest()
print(f"⑤ 取回比对: {'★逐字节一致★' if dst_sha == src_sha else '☠ 内容不一致!'}  sha={dst_sha[:12]}")

for k in (SRC, DST, DST + "-plain"):
    s3.delete_object(Bucket=bkt, Key=k)
print("⑥ 清理完毕")
