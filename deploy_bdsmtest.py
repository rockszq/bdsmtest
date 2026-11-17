# -*- coding: utf-8 -*-
"""
bdsmtest 部署脚本：上传 index.html 到 test.songtears.com 站点目录。
凭据与会话复用九天御神阁项目（ftp_config.json / bt_session.json），只读不写。
面板调用参数与 deploy_site.py 保持一致（GetDirNew / upload）。

用法：
  python deploy_bdsmtest.py --probe    # 只探测：列站点目录
  python deploy_bdsmtest.py            # 部署（备份远端旧文件 -> 上传 -> 逐字节校验 -> 线上访问）
  python deploy_bdsmtest.py --verify   # 只校验
"""
import hashlib
import json
import os
import re
import shutil
import sys
from datetime import datetime

BT_DIR = r"D:\test\jiuyetian"
sys.path.insert(0, BT_DIR)

import deploy_site as ds

CFG = ds.load_json(os.path.join(BT_DIR, "ftp_config.json"))
SESS = ds.load_json(os.path.join(BT_DIR, "bt_session.json"), required=False)
LOCAL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "index.html")
WWWROOT = "/www/wwwroot/"
TARGET_CANDIDATES = ["test.songtears.com", "test_songtears_com", "songtears-test"]
TARGET_SITE_URL = "http://test.songtears.com/"


def api(action, data=None, file_path=None, timeout=60):
    return ds.panel_api(SESS, CFG["panel"], action, data=data, file_path=file_path, timeout=timeout)


def list_dir(path):
    """返回 (dirs, files) 或 None。files 为 {name: size}。"""
    ok, text = api("GetDirNew", {"p": "1", "showRow": "500", "path": path,
                                 "sort": "", "reverse": "True"})
    if not ok or ds.panel_stale(text) or '"files"' not in text:
        return None
    try:
        o = json.loads(text)
        dirs = [d.get("nm") or d.get("filename") for d in o.get("DIR", [])]
        files = {}
        for f in o.get("files", []):
            nm = f.get("nm") or f.get("filename")
            if nm:
                files[nm] = f.get("sz", -1)
        return dirs, files
    except Exception:
        return None


def probe():
    r = list_dir(WWWROOT)
    if r is None:
        print("[FAIL] 无法列出", WWWROOT, "（会话失效则到九天阁项目重跑 deploy_site.py --dry-run 刷新 bt_session.json）")
        return 1
    dirs, files = r
    print("[OK] %s 下目录 %d 个:" % (WWWROOT, len(dirs)))
    for d in sorted(dirs):
        mark = "   <-- songtears 相关" if "songtears" in d.lower() or d.lower().startswith("test") else ""
        print("   " + d + mark)
    if files:
        print("[INFO] 根下文件:", ", ".join(sorted(files))[:200])
    return 0


def sha256_local(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def find_target_dir():
    # 先直接试探候选目录（wwwroot 根的目录列表可能受权限限制返回空）
    for cand in TARGET_CANDIDATES:
        d = WWWROOT + cand
        r = list_dir(d)
        if r is not None:
            return d
    return None


def read_remote_file(remote_path):
    ok, text = api("GetFileBody", data={"path": remote_path}, timeout=30)
    if not ok:
        return None, "transport error"
    if ds.panel_stale(text):
        return None, "session stale"
    try:
        o = json.loads(text)
        if o.get("status") is False:
            return None, o.get("msg", "?")
        # 宝塔 GetFileBody 的内容字段是小写 data（大写 DATA 不存在）
        return o.get("data", ""), None
    except Exception:
        return None, text[:120]


SNAPSHOT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "snapshots")
SNAPSHOT_KEEP = 10


def local_snapshot():
    """部署前给当前 index.html 存一份带时间戳的本地快照，保留最近 N 个。
    不依赖 git（本仓库零 commit），提供真实可回滚点。"""
    os.makedirs(SNAPSHOT_DIR, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    dst = os.path.join(SNAPSHOT_DIR, "index.%s.html" % stamp)
    shutil.copy2(LOCAL, dst)
    snaps = sorted(
        (f for f in os.listdir(SNAPSHOT_DIR) if re.match(r"^index\.\d{8}-\d{6}\.html$", f)),
        reverse=True,
    )
    for old in snaps[SNAPSHOT_KEEP:]:
        os.remove(os.path.join(SNAPSHOT_DIR, old))
    print("[OK] 本地快照: %s (保留最近 %d 个)" % (os.path.basename(dst), SNAPSHOT_KEEP))


def main():
    mode = sys.argv[1] if len(sys.argv) > 1 else "--deploy"

    if mode == "--probe":
        return probe()

    if not os.path.exists(LOCAL):
        print("[FAIL] 本地文件不存在:", LOCAL)
        return 1

    target = find_target_dir()
    if not target:
        print("[FAIL] 未找到目标目录。运行 --probe 查看 %s 实际目录。" % WWWROOT)
        return 1
    print("[OK] 目标目录:", target)

    r = list_dir(target)
    if r is None:
        print("[FAIL] 无法列出目标目录")
        return 1
    _, remote_files = r
    print("[INFO] 远端现有文件:", ", ".join(sorted(remote_files)) or "(空)")

    local_sha = sha256_local(LOCAL)
    print("[INFO] 本地 index.html: size=%d sha256=%s..." % (os.path.getsize(LOCAL), local_sha[:16]))

    remote_index = target + "/index.html"

    # 1) 备份远端旧文件（若已有 index.html 且不是今天备份过的）
    if "index.html" in remote_files:
        bak = "index.html.bak-20261016"
        if bak not in remote_files:
            ok, text = api("CopyFile", {"sfile": remote_index, "dfile": target + "/" + bak})
            if ds.panel_ok(text):
                print("[OK] 远端旧文件已备份为", bak)
            else:
                print("[WARN] 备份失败（继续上传）:", ds.brief(text))
        else:
            print("[INFO] 已存在备份", bak)

    # 2) 上传（先存本地快照，提供可回滚点）
    if mode != "--verify":
        local_snapshot()
        size = os.path.getsize(LOCAL)
        ok, text = api("upload",
                       {"f_path": target + "/", "f_name": "index.html",
                        "f_size": str(size), "f_start": "0"},
                       file_path=LOCAL)
        if not ok or not ds.panel_ok(text):
            print("[FAIL] 上传失败:", ds.brief(text))
            return 1
        print("[OK] index.html 已上传")

    # 3) 逐字节校验
    content, err = read_remote_file(remote_index)
    if content is None:
        print("[FAIL] 校验失败（拉回远端文件）:", err)
        return 1
    remote_sha = hashlib.sha256(content.encode("utf-8", "surrogateescape")).hexdigest()
    if remote_sha != local_sha:
        print("[FAIL] 校验不一致!")
        print("   本地 =", local_sha)
        print("   远端 =", remote_sha)
        return 1
    print("[OK] 线上文件与本地逐字节一致 (sha256 %s...)" % remote_sha[:16])

    # 4) 线上访问检查
    import time
    import urllib.request
    for i in range(3):
        try:
            req = urllib.request.Request(TARGET_SITE_URL, headers={"User-Agent": ds.UA})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", "replace")
                if "startBtn" in body or "倾向自评" in body:
                    print("[OK] 线上访问正常:", TARGET_SITE_URL)
                    return 0
                print("[WARN] 线上可访问但内容不像本项目（可能 CDN 缓存），长度", len(body))
                return 0
        except Exception as e:
            print("[WARN] 线上访问第 %d 次失败: %s" % (i + 1, e))
            time.sleep(2)
    print("[INFO] 文件已确认上传一致；线上访问暂不通，可能为 DNS/缓存原因，请稍后浏览器验证。")
    return 0


if __name__ == "__main__":
    sys.exit(main())