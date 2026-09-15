"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.VscodeFileProvider = void 0;
exports.samePath = samePath;
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
class VscodeFileProvider {
    constructor(getGlobs) {
        this.getGlobs = getGlobs;
    }
    async listFiles() {
        const { include, exclude } = this.getGlobs();
        const inc = include.length === 1 ? include[0] : `{${include.join(',')}}`;
        const exc = exclude.length === 1 ? exclude[0] : `{${exclude.join(',')}}`;
        const uris = await vscode.workspace.findFiles(inc, exc, 20000);
        return uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    }
    /**
     * IP 例化模板：Vivado 生成的 .veo / .vho 里通常带端口方向声明，
     * 读了它就能把"方向未知的黑盒"变成有方向的普通模块。
     */
    async listAuxFiles() {
        const { aux, exclude } = this.getGlobs();
        if (aux.length === 0)
            return [];
        const pat = aux.length === 1 ? aux[0] : `{${aux.join(',')}}`;
        const exc = exclude.length === 1 ? exclude[0] : `{${exclude.join(',')}}`;
        const uris = await vscode.workspace.findFiles(pat, exc, 4000);
        return uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
    }
    /** 文件指纹：索引缓存用它判断"内容是否还是上次那份" */
    async stat(p) {
        try {
            const s = await vscode.workspace.fs.stat(vscode.Uri.file(p));
            return { mtimeMs: s.mtime, size: s.size };
        }
        catch {
            return null;
        }
    }
    async readFile(p) {
        // 优先使用编辑器中的内容（含未保存修改），保证追踪结果与眼前所见一致
        const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, p));
        if (doc)
            return doc.getText();
        const data = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
        return Buffer.from(data).toString('utf8');
    }
    async exists(p) {
        try {
            await vscode.workspace.fs.stat(vscode.Uri.file(p));
            return true;
        }
        catch {
            return false;
        }
    }
    async resolveInclude(fromFile, includeName) {
        const candidates = [];
        candidates.push(path.join(path.dirname(fromFile), includeName));
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            candidates.push(path.join(folder.uri.fsPath, includeName));
        }
        for (const c of candidates) {
            if (await this.exists(c))
                return c;
        }
        return null;
    }
}
exports.VscodeFileProvider = VscodeFileProvider;
function samePath(a, b) {
    return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
//# sourceMappingURL=fsProvider.js.map