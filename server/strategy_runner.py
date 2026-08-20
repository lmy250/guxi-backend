#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""客户自定义策略沙箱执行器（回测系统用）。

协议（从 stdin 读 JSON，输出 JSON 到 stdout）：
  输入: {"mode": "validate" | "run", "code": "<策略源码>", "kline": [<K线字典>...]}
  输出: {"valid": true/false, "signals": [...], "errors": ["..."]}
    - mode=validate: 只做语法检查 + 确认定义了 generate_signals 函数，不执行策略。
    - mode=run:      在受限环境执行 generate_signals(kline)，返回归一化信号数组。

客户脚本约定：
    def generate_signals(kline):
        # kline: list[dict]，每项含 date/open/high/low/close/volume
        # return: list，长度与 kline 相同，元素 ∈ {-1, 0, 1}
        #   1=买入/持仓   -1=卖出/空仓   0=不变
        return [0] * len(kline)

安全措施（尽力而为的沙箱，非绝对隔离）：
  1. AST 层禁止 import / import from；
  2. 禁止访问双下划线特殊属性与危险内置名（__import__/open/eval/exec/type 等）；
  3. 只提供受限 builtins 白名单；
  4. sys.addaudithook 拦截子进程/文件/网络/系统等危险调用；
  5. 调用方（Node）对进程设置超时，超时即杀。
"""
import sys
import json
import ast

# ---- 安全加固：拦截危险系统调用 ----
def _block(event, args):
    if event.startswith(('subprocess.', 'os.', 'open', 'socket.', 'shutil.', 'winreg', 'ctypes')):
        raise RuntimeError('forbidden operation: ' + event)

sys.addaudithook(_block)

_SAFE_BUILTINS = {
    'len': len, 'range': range, 'min': min, 'max': max, 'sum': sum, 'abs': abs,
    'round': round, 'list': list, 'dict': dict, 'tuple': tuple, 'set': set,
    'enumerate': enumerate, 'zip': zip, 'map': map, 'filter': filter,
    'sorted': sorted, 'reversed': reversed, 'any': any, 'all': all,
    'float': float, 'int': int, 'str': str, 'bool': bool, 'pow': pow,
    'divmod': divmod, 'True': True, 'False': False, 'None': None,
    'Exception': Exception, 'ValueError': ValueError, 'TypeError': TypeError,
    'IndexError': IndexError, 'KeyError': KeyError,
}

_FORBIDDEN_NAMES = {
    '__import__', 'open', 'eval', 'exec', 'compile', 'input',
    'globals', 'locals', 'vars', 'getattr', 'setattr', 'delattr', 'hasattr',
    'type', 'object', 'super', 'memoryview', 'bytearray', 'bytes', 'chr', 'ord',
}

def _static_check(tree):
    """AST 静态检查：禁 import、禁危险属性/名字。"""
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            return ['不允许 import 模块: ' + ', '.join(a.name for a in node.names)]
        if isinstance(node, ast.ImportFrom):
            return ['不允许 import 模块: ' + (node.module or '')]
        if isinstance(node, ast.Attribute) and node.attr.startswith('__'):
            return ['禁止访问特殊属性 ' + node.attr]
        if isinstance(node, ast.Name) and node.id in _FORBIDDEN_NAMES:
            return ['禁止使用内置名: ' + node.id]
    return []

def run(mode, code, kline):
    try:
        tree = ast.parse(code)
    except SyntaxError as e:
        return {'valid': False, 'errors': ['语法错误: %s (第 %d 行)' % (e.msg, e.lineno)]}

    errs = _static_check(tree)
    if errs:
        return {'valid': False, 'errors': errs}

    g = {'__builtins__': _SAFE_BUILTINS}
    try:
        exec(compile(tree, '<strategy>', 'exec'), g)
    except Exception as e:
        return {'valid': False, 'errors': ['代码执行失败: %s: %s' % (type(e).__name__, e)]}

    if 'generate_signals' not in g or not callable(g['generate_signals']):
        return {'valid': False, 'errors': ['必须定义 generate_signals(kline) 函数']}

    if mode == 'validate':
        return {'valid': True, 'errors': []}

    try:
        sig = g['generate_signals'](kline)
    except Exception as e:
        return {'valid': False, 'errors': ['策略运行出错: %s: %s' % (type(e).__name__, e)]}

    if not isinstance(sig, (list, tuple)):
        return {'valid': False, 'errors': ['generate_signals 必须返回 list']}
    sig = list(sig)
    n = len(kline)
    if len(sig) != n:
        return {'valid': False, 'errors': ['信号长度 %d 与 K线 %d 不一致' % (len(sig), n)]}

    norm = []
    for v in sig:
        try:
            x = float(v)
        except (TypeError, ValueError):
            return {'valid': False, 'errors': ['非法信号值: %r' % (v,)]}
        norm.append(1 if x > 0 else (-1 if x < 0 else 0))
    return {'valid': True, 'signals': norm, 'errors': []}

def main():
    raw = sys.stdin.read()
    try:
        data = json.loads(raw or '{}')
    except ValueError:
        print(json.dumps({'valid': False, 'errors': ['输入不是合法 JSON']}))
        return
    res = run(data.get('mode', 'run'), data.get('code', ''), data.get('kline', []))
    print(json.dumps(res))

if __name__ == '__main__':
    main()
