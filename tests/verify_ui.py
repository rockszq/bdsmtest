# -*- coding: utf-8 -*-
"""
第四层回归：UI 静态检查。
防的是「样式/文案与实现脱节」这一类问题，历史上真实发生过：
  - 视觉重构只改了卡片容器，漏掉 a 元素颜色定义 -> 浏览器默认蓝漏出
  - hint 文案承诺「数字键 1-5 作答」但代码里没有键盘导航
  - canvas 赋值 var(--x) 静默失效
这类问题计分层和端到端都抓不到（mock 环境下颜色和文案不会"显示"出来）。
"""
import io
import re
import sys

PATH = os_path = 'index.html'
with io.open(PATH, 'r', encoding='utf-8') as f:
    src = f.read()

errors = []
warnings = []

style = src.split('</style>')[0]
script = src[src.index('<script>'):src.index('</script>')] if '<script>' in src else ''
body = src[src.index('<body>'):src.index('<script>')]

print('=' * 62)
print('1. 链接必须有显式颜色（防浏览器默认蓝）')
print('=' * 62)
# 必须匹配 color 属性声明（color: 值;），不能用 [^}]*color——
# transition: color 0.2s 里的 color 会造成假阳性（故障注入 F1 已实证）。
if not re.search(r'(?:^|\n)\s*a\s*\{[^}]*?(?:^|\n)\s*color\s*:', style):
    errors.append('CSS 缺少 a 元素的全局 color 声明（会漏出浏览器默认蓝）')
else:
    print('  [OK] 存在 a { color: ... } 全局定义')
for ctx_name, ctx in [('HTML', body)]:
    n_link = len(re.findall(r'<a[\s>]', ctx))
    if n_link:
        print('  HTML 静态链接 %d 个（颜色由全局规则覆盖）' % n_link)

print()
print('=' * 62)
print('2. 文案承诺的功能必须有实现')
print('=' * 62)
# 功能承诺扫描：不再用固定白名单（白名单漏掉了「空格键」——故障注入 F10 实证）。
# 改为通用模式：抓取文案里「按X键/双击/长按/滑动」等操作承诺，键名必须有 keydown 实现。
# 只扫描 HTML 正文与 JS 字符串字面量，跳过 CSS 与注释。
user_text = body + '\n' + '\n'.join(
    m[1] for m in re.findall(r"(['\"`])([^'\"`]{4,120}?)\1", script)
)
key_claims = re.findall(r'(?:按|使用|通过)\s*(空格|回车|Enter|Esc|退出|Tab|数字|方向|←|→|↑|↓)\s*键?', user_text, re.I)
# 实现标志必须是"有意义的键判断表达式"，不能用单字符（' ' in script 恒真）。
key_impl_map = {
    '空格': ["code === 'Space'", "key === ' '", "keyCode === 32"],
    '回车': ["Enter"], 'Enter': ["Enter"],
    'Esc': ["Escape", "Esc"], '退出': ["Escape", "Esc"],
    'Tab': ["Tab"], '数字': ["keydown"], '方向': ["Arrow"],
    '←': ["ArrowLeft"], '→': ["ArrowRight"], '↑': ["ArrowUp"], '↓': ["ArrowDown"],
}
for claim in sorted(set(key_claims)):
    markers = key_impl_map.get(claim, [claim])
    if not any(m in script for m in markers):
        errors.append('文案承诺了「按%s键」类操作但代码无对应实现（需 %s）' % (claim, '/'.join(markers)))
    else:
        print('  [OK] 「按%s键」已承诺且已实现' % claim)

# 保留原有的三项精确承诺（覆盖非按键类功能）
promises = [
    (r'导出结果', 'exportResults', '导出功能'),
]
for pattern, impl, name in promises:
    promised = bool(re.search(pattern, src))
    implemented = impl in script
    if promised and not implemented:
        errors.append('文案承诺了「%s」但代码无 %s 实现' % (name, impl))
    elif promised:
        print('  [OK] 「%s」已承诺且已实现' % name)
# 反向检查：keydown 里用到的按键，hint 是否提及
if 'ArrowLeft' in script and not re.search(r'←', src.split('<script>')[0]):
    warnings.append('代码实现了 ← 键但页面文案未提示')

print()
print('=' * 62)
print('3. canvas 不允许使用 CSS var()')
print('=' * 62)
canvas_bad = re.findall(r"ctx\.(?:fillStyle|strokeStyle)\s*=\s*[^;]*var\(", script)
if canvas_bad:
    errors.append('canvas 使用了 var()（会静默失效）: %d 处' % len(canvas_bad))
else:
    print('  [OK] canvas 全部为字面色值')

print()
print('=' * 62)
print('4. JS 模板生成的 class 必须在 CSS 中定义')
print('=' * 62)
tpl_classes = set(re.findall(r'class=\\?"([a-z][a-z0-9 -]+)\\?"', script))
tpl_classes |= set(re.findall(r"classList\.(?:add|toggle)\('([a-z-]+)'\)", script))
missing = []
for cls_group in tpl_classes:
    for cls in cls_group.split():
        if cls in ('active', 'visible', 'selected'):
            continue  # 状态类，通常成对出现
        if ('.' + cls) not in style and not cls.startswith('tab-'):
            missing.append(cls)
missing = sorted(set(missing))
if missing:
    warnings.append('JS 模板引用但 CSS 未定义的类: %s' % ', '.join(missing))
    print('  [WARN] %s' % ', '.join(missing))
else:
    print('  [OK] 全部已定义')

print()
print('=' * 62)
print('5. initElements 引用的 id 必须存在于 HTML')
print('=' * 62)
ids_block = re.search(r"const ids = \[(.*?)\];", script, re.S)
if ids_block:
    ids = re.findall(r"'([^']+)'", ids_block.group(1))
    missing_ids = [i for i in ids if ('id="%s"' % i) not in src]
    if missing_ids:
        errors.append('initElements 引用了不存在的 id: %s' % ', '.join(missing_ids))
    else:
        print('  [OK] %d 个 id 全部存在' % len(ids))

print()
print('=' * 62)
print('6. 内联样式引用的 CSS 变量必须已定义')
print('=' * 62)
defined = set(re.findall(r'(--[a-z0-9-]+)\s*:', style))
used = set(re.findall(r'var\((--[a-z0-9-]+)', src))
undefined = sorted(used - defined)
if undefined:
    errors.append('引用了未定义的 CSS 变量: %s' % ', '.join(undefined))
else:
    print('  [OK] %d 个被引用变量全部已定义' % len(used))

print()
print('=' * 62)
print('7. 空链接与外链检查')
print('=' * 62)
empty_links = re.findall(r'<a[^>]*href="\s*"', body)
if empty_links:
    errors.append('存在空 href 链接 %d 处' % len(empty_links))
else:
    print('  [OK] 无空链接')

print()
print('=' * 62)
print('8. JS 语法')
print('=' * 62)
import subprocess
NODE = r"C:\Users\rockszq\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"
check = subprocess.run(
    [NODE, '-e',
     "const fs=require('fs');const m=fs.readFileSync('index.html','utf-8').match(/<script>([\\s\\S]*?)<\\/script>/);"
     "try{new Function(m[1]);console.log('OK')}catch(e){console.log('ERR:'+e.message);process.exit(1)}"],
    capture_output=True, text=True, encoding='utf-8', errors='replace')
if check.returncode != 0:
    errors.append('JS 语法错误: %s' % (check.stdout or check.stderr).strip()[:200])
else:
    print('  [OK] script 语法通过')

print()
print('=' * 62)
print('结论')
print('=' * 62)
if errors:
    print('[FAIL] %d 项:' % len(errors))
    for e in errors:
        print('  X ' + e)
else:
    print('[PASS] UI 静态检查全部通过')
if warnings:
    print('\n[WARN] %d 项:' % len(warnings))
    for w in warnings:
        print('  ! ' + w)

sys.exit(1 if errors else 0)