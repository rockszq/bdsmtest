# -*- coding: utf-8 -*-
"""
回归测试统一入口。
用法：  python tests/run_all.py
退出码：0 = 全部通过；1 = 存在失败。

三层防线（+UI 静态层）：
  1. verify_scale.py    结构层 —— 题库结构、反向题、维度分布、措辞残留扫描
  2. verify_runtime.mjs 计分层 —— 用 Node vm 执行页面 JS，校验计分与一致性检测
  3. test_e2e.mjs       端到端 —— 真实页面代码 + DOM mock，12 种人格画像跑完整结果生成，
                          校验分数与结果文案自洽
  4. verify_ui.py       UI 静态层 —— 链接颜色、文案承诺的功能必须有实现、canvas 字面色、
                          CSS 类/变量/id 引用完整性

修改 index.html 后必须重跑本脚本；四层全绿才允许交付。
"""
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = r"C:\Users\rockszq\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
PYTHON = r"C:\Users\rockszq\.workbuddy\binaries\python\versions\3.13.12\python.exe"

CHECKS = [
    ('结构层 verify_scale.py', [PYTHON, 'tests/verify_scale.py']),
    ('计分层 verify_runtime.mjs', [NODE, 'tests/verify_runtime.mjs']),
    ('端到端 test_e2e.mjs', [NODE, 'tests/test_e2e.mjs']),
    ('UI静态层 verify_ui.py', [PYTHON, 'tests/verify_ui.py']),
]


def main():
    print('=' * 66)
    print('回归测试：D:/test/bdsmtest/index.html')
    print('=' * 66)

    failed = []
    for name, cmd in CHECKS:
        print()
        print('-' * 66)
        print('[RUN] ' + name)
        print('-' * 66)
        try:
            proc = subprocess.run(
                cmd, cwd=ROOT,
                capture_output=True, text=True, encoding='utf-8', errors='replace',
                timeout=120,
            )
            out = (proc.stdout or '') + (proc.stderr or '')
            # 只打印结论附近的关键行，避免刷屏
            lines = [l for l in out.splitlines() if l.strip()]
            tail = lines[-40:] if len(lines) > 40 else lines
            print('\n'.join(tail))
            if proc.returncode != 0:
                failed.append(name)
                print('[FAIL] ' + name)
            else:
                print('[PASS] ' + name)
        except Exception as e:
            failed.append(name)
            print('[ERROR] %s: %s' % (name, e))

    print()
    print('=' * 66)
    if failed:
        print('结果：[FAIL] %d/%d 项未通过' % (len(failed), len(CHECKS)))
        for f in failed:
            print('  X ' + f)
        return 1
    print('结果：[PASS] 全部 %d 层检查通过' % len(CHECKS))
    return 0


if __name__ == '__main__':
    sys.exit(main())