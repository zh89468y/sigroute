"use strict";
/**
 * Verilog / SystemVerilog 词法分析器
 *
 * 关键能力（决定后续解析准确率）：
 *  1. 正确处理行注释 / 块注释 / 字符串，避免把注释里的例化当真
 *  2. 记录 `define / `include / `undef
 *  3. 依据宏定义裁剪 `ifdef / `ifndef / `elsif / `else 分支 —— 被裁掉的 token 标记 inactive
 *     而不是直接丢弃，这样将来可以做"另一分支"的对比分析
 *
 * 这里刻意不做宏体展开：本工具关心的是"连接拓扑"，不是"值计算"，
 * 宏体展开带来的复杂度远大于收益。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.KEYWORDS = exports.TokType = void 0;
exports.lex = lex;
exports.isPlainIdent = isPlainIdent;
exports.isPunct = isPunct;
exports.isIdent = isIdent;
exports.TokType = {
    Ident: 'ident',
    Number: 'number',
    String: 'string',
    /** `MACRO 调用 */
    Directive: 'directive',
    Punct: 'punct',
    /** $display 之类 */
    SysTask: 'systask',
};
/** Verilog-2001 + 常用 SystemVerilog 关键字（用于区分标识符与语法结构） */
exports.KEYWORDS = new Set([
    // 结构
    'module', 'endmodule', 'macromodule', 'interface', 'endinterface', 'program', 'endprogram',
    'package', 'endpackage', 'generate', 'endgenerate', 'begin', 'end', 'fork', 'join', 'join_any', 'join_none',
    'function', 'endfunction', 'task', 'endtask', 'class', 'endclass', 'covergroup', 'endgroup',
    'specify', 'endspecify', 'table', 'endtable', 'primitive', 'endprimitive', 'config', 'endconfig',
    'checker', 'endchecker', 'clocking', 'endclocking', 'property', 'endproperty', 'sequence', 'endsequence',
    'modport', 'import', 'export',
    // 声明
    'input', 'output', 'inout', 'ref',
    'wire', 'reg', 'logic', 'bit', 'byte', 'shortint', 'int', 'longint', 'integer', 'real', 'realtime',
    'time', 'shortreal', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'trireg', 'wand', 'wor', 'supply0', 'supply1',
    'uwire', 'signed', 'unsigned', 'automatic', 'static', 'const', 'var', 'localparam', 'parameter', 'defparam',
    'genvar', 'event', 'typedef', 'enum', 'struct', 'union', 'packed', 'virtual', 'interface_class', 'extends',
    'new', 'null', 'this', 'super', 'rand', 'randc', 'constraint', 'solve', 'before', 'with', 'inside',
    'local', 'protected', 'extern', 'pure', 'context', 'void', 'chandle', 'string', 'type', 'scalared', 'vectored',
    // 过程
    'always', 'always_comb', 'always_ff', 'always_latch', 'initial', 'final',
    'assign', 'deassign', 'force', 'release', 'posedge', 'negedge', 'edge',
    'if', 'else', 'case', 'casez', 'casex', 'endcase', 'default', 'for', 'while', 'repeat', 'forever',
    'do', 'foreach', 'return', 'break', 'continue', 'disable', 'wait', 'wait_order',
    'unique', 'unique0', 'priority', 'assert', 'assume', 'cover', 'expect', 'restrict',
    'and', 'or', 'not', 'nand', 'nor', 'xor', 'xnor', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1',
    'nmos', 'pmos', 'cmos', 'rnmos', 'rpmos', 'rcmos', 'tran', 'tranif0', 'tranif1', 'rtran', 'rtranif0', 'rtranif1',
    'pullup', 'pulldown', 'cmos', 'pass', 'pass_enable', 'pass_switch',
    'pulldown', 'primitive',
    // 时序/断言
    'timeunit', 'timeprecision',
    // 其他
    'automatic', 'cell', 'design', 'endcell', 'instance', 'liblist', 'library', 'use', 'incdir',
    'options', 'defparam', 'alias', 'bind',
]);
/** 指令后需要整行跳过（参数是文本而非表达式）的情况 */
const LINE_DIRECTIVES = new Set([
    'timescale', 'line', 'default_nettype', 'resetall', 'celldefine', 'endcelldefine',
    'unconnected_drive', 'nounconnected_drive', 'pragma', 'begin_keywords', 'end_keywords',
]);
const PUNCT3 = ['===', '!==', '<<<', '>>>', '<<<=', '>>>=', '==?', '!=?'];
const PUNCT2 = [
    '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '**', '~&', '~|', '^~', '~^',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->', '=>', '::', '++', '--', '.*',
];
function isIdentStart(ch) {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isIdentChar(ch) {
    return isIdentStart(ch) || (ch >= '0' && ch <= '9') || ch === '$';
}
function isDigit(ch) {
    return ch >= '0' && ch <= '9';
}
function lex(text, opts) {
    const tokens = [];
    const localDefines = [];
    const localUndefines = [];
    const includes = [];
    const len = text.length;
    let i = 0;
    let line = 0;
    const condStack = [];
    const isActive = () => (opts.honorIfdef ? condStack.every((f) => f.active) : true);
    const push = (type, value, start, end, ln, active) => {
        tokens.push({ type, value, start, end, line: ln, inactive: !active });
    };
    /** 跳过空白与注释，返回是否遇到换行（用于行计数在调用方统一处理） */
    const skipWhiteAndComment = () => {
        while (i < len) {
            const ch = text[i];
            if (ch === '\n') {
                line++;
                i++;
            }
            else if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f' || ch === '\v') {
                i++;
            }
            else if (ch === '/' && text[i + 1] === '/') {
                i += 2;
                while (i < len && text[i] !== '\n')
                    i++;
            }
            else if (ch === '/' && text[i + 1] === '*') {
                i += 2;
                while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
                    if (text[i] === '\n')
                        line++;
                    i++;
                }
                i += 2;
            }
            else {
                break;
            }
        }
    };
    /** 跳过到行尾（含反斜杠续行），用于 `timescale 1ns/1ns 这类指令 */
    const skipToEol = () => {
        while (i < len) {
            const ch = text[i];
            if (ch === '\\' && (text[i + 1] === '\n' || (text[i + 1] === '\r' && text[i + 2] === '\n'))) {
                if (text[i + 1] === '\r')
                    i++;
                i += 2;
                line++;
                continue;
            }
            if (ch === '\n') {
                line++;
                i++;
                break;
            }
            if (ch === '/' && text[i + 1] === '/')
                break;
            if (ch === '/' && text[i + 1] === '*') {
                i += 2;
                while (i < len && !(text[i] === '*' && text[i + 1] === '/')) {
                    if (text[i] === '\n')
                        line++;
                    i++;
                }
                i += 2;
                continue;
            }
            i++;
        }
    };
    /** 读取一行前面的标识符（宏名） */
    const readMacroName = () => {
        const s = i;
        while (i < len && isIdentChar(text[i]))
            i++;
        return text.slice(s, i);
    };
    while (i < len) {
        skipWhiteAndComment();
        if (i >= len)
            break;
        const ch = text[i];
        const active = isActive();
        // ---------- 预处理指令 ----------
        if (ch === '`') {
            const start = i;
            const startLine = line;
            i++; // 吃掉反引号
            const name = readMacroName();
            const lower = name.toLowerCase();
            if (lower === 'ifdef' || lower === 'ifndef') {
                skipWhiteAndComment();
                const macro = readMacroName();
                const parentActive = condStack.length === 0 ? true : condStack[condStack.length - 1].active;
                const defined = opts.defines.has(macro);
                const cond = lower === 'ifdef' ? defined : !defined;
                condStack.push({ parentActive, active: parentActive && cond, taken: cond });
                continue;
            }
            if (lower === 'elsif') {
                skipWhiteAndComment();
                const macro = readMacroName();
                const frame = condStack[condStack.length - 1];
                if (frame) {
                    const cond = opts.defines.has(macro);
                    frame.active = frame.parentActive && !frame.taken && cond;
                    frame.taken = frame.taken || cond;
                }
                continue;
            }
            if (lower === 'else') {
                const frame = condStack[condStack.length - 1];
                if (frame) {
                    frame.active = frame.parentActive && !frame.taken;
                    frame.taken = true;
                }
                continue;
            }
            if (lower === 'endif') {
                condStack.pop();
                continue;
            }
            if (lower === 'define') {
                skipWhiteAndComment();
                const macro = readMacroName();
                if (macro) {
                    // 非函数式宏（或函数式宏名）都记录
                    opts.defines.add(macro);
                    localDefines.push(macro);
                }
                skipToEol();
                continue;
            }
            if (lower === 'undef') {
                skipWhiteAndComment();
                const macro = readMacroName();
                if (macro) {
                    opts.defines.delete(macro);
                    localUndefines.push(macro);
                }
                skipToEol();
                continue;
            }
            if (lower === 'include') {
                skipWhiteAndComment();
                if (text[i] === '"') {
                    const s = ++i;
                    while (i < len && text[i] !== '"' && text[i] !== '\n')
                        i++;
                    const file = text.slice(s, i);
                    includes.push(file);
                    if (text[i] === '"')
                        i++;
                }
                else if (text[i] === '<') {
                    const s = ++i;
                    while (i < len && text[i] !== '>' && text[i] !== '\n')
                        i++;
                    includes.push(text.slice(s, i));
                    if (text[i] === '>')
                        i++;
                }
                skipToEol();
                continue;
            }
            if (LINE_DIRECTIVES.has(lower)) {
                skipToEol();
                continue;
            }
            // 普通宏调用：产生一个 Directive token（parser 会忽略）
            push(exports.TokType.Directive, name, start, i, startLine, active);
            continue;
        }
        // ---------- 字符串 ----------
        if (ch === '"') {
            const start = i;
            const startLine = line;
            i++;
            while (i < len && text[i] !== '"') {
                if (text[i] === '\\') {
                    i++;
                    if (i < len && text[i] === '\n')
                        line++;
                }
                if (i < len && text[i] === '\n')
                    break; // 未闭合，防死循环
                i++;
            }
            i++;
            push(exports.TokType.String, text.slice(start, i), start, i, startLine, active);
            continue;
        }
        // ---------- 系统任务 $display ----------
        if (ch === '$') {
            const start = i;
            i++;
            while (i < len && isIdentChar(text[i]))
                i++;
            push(exports.TokType.SysTask, text.slice(start, i), start, i, line, active);
            continue;
        }
        // ---------- 数字 ----------
        // 形式：123 / 8'hFF / 1'b0 / 4'd10 / 8'sd5 / 'd0 / 1'bx / 1.5e3
        if (isDigit(ch) || (ch === "'" && /[sSbBoOdDhH]/.test(text[i + 1] ?? ''))) {
            const start = i;
            while (i < len && (isDigit(text[i]) || text[i] === '_'))
                i++;
            if (text[i] === "'") {
                i++;
                if (/[sS]/.test(text[i] ?? ''))
                    i++;
                if (/[bBoOdDhH]/.test(text[i] ?? ''))
                    i++;
                while (i < len && /[0-9a-fA-FxXzZ?_]/.test(text[i]))
                    i++;
            }
            else {
                // 实数 / 指数
                if (text[i] === '.' && isDigit(text[i + 1] ?? '')) {
                    i++;
                    while (i < len && isDigit(text[i]))
                        i++;
                }
                if ((text[i] === 'e' || text[i] === 'E') && /[0-9+-]/.test(text[i + 1] ?? '')) {
                    i++;
                    if (text[i] === '+' || text[i] === '-')
                        i++;
                    while (i < len && isDigit(text[i]))
                        i++;
                }
            }
            // 时间单位后缀：1ns / 10ps
            if (/[a-zA-Z]/.test(text[i] ?? '')) {
                const s2 = i;
                while (i < len && /[a-zA-Z]/.test(text[i]))
                    i++;
                const unit = text.slice(s2, i).toLowerCase();
                if (!['ns', 'ps', 'us', 'ms', 's', 'fs', 'step'].includes(unit)) {
                    i = s2; // 不是时间单位，回退
                }
            }
            push(exports.TokType.Number, text.slice(start, i), start, i, line, active);
            continue;
        }
        // ---------- 标识符 / 关键字 ----------
        if (isIdentStart(ch)) {
            const start = i;
            while (i < len && isIdentChar(text[i]))
                i++;
            const value = text.slice(start, i);
            push(exports.TokType.Ident, value, start, i, line, active);
            continue;
        }
        // ---------- 运算符 ----------
        const three = text.slice(i, i + 3);
        if (PUNCT3.includes(three)) {
            push(exports.TokType.Punct, three, i, i + 3, line, active);
            i += 3;
            continue;
        }
        const two = text.slice(i, i + 2);
        if (PUNCT2.includes(two)) {
            push(exports.TokType.Punct, two, i, i + 2, line, active);
            i += 2;
            continue;
        }
        // ---------- 单字符 ----------
        push(exports.TokType.Punct, ch, i, i + 1, line, active);
        i++;
    }
    return {
        tokens,
        defines: localDefines,
        undefines: localUndefines,
        includes,
        hasBalancedEndmodule: tokens.some((t) => t.value === 'endmodule' && !t.inactive),
    };
}
/** 判断 token 是否是一个"标识符"（排除关键字），作为类型守卫使用 */
function isPlainIdent(t) {
    return !!t && t.type === exports.TokType.Ident && !exports.KEYWORDS.has(t.value);
}
function isPunct(t, v) {
    return !!t && t.type === exports.TokType.Punct && t.value === v;
}
function isIdent(t, v) {
    return !!t && t.type === exports.TokType.Ident && t.value === v;
}
//# sourceMappingURL=lexer.js.map