import * as path from 'path';
import * as vscode from 'vscode';
import type { FileProvider } from '../core/indexer';

export interface GlobConfig {
  include: string[];
  exclude: string[];
  /** 仅用于补齐黑盒 IP 端口方向的辅助文件（例化模板等） */
  aux: string[];
}

export class VscodeFileProvider implements FileProvider {
  private readonly getGlobs: () => GlobConfig;

  constructor(getGlobs: () => GlobConfig) {
    this.getGlobs = getGlobs;
  }

  async listFiles(): Promise<string[]> {
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
  async listAuxFiles(): Promise<string[]> {
    const { aux, exclude } = this.getGlobs();
    if (aux.length === 0) return [];
    const pat = aux.length === 1 ? aux[0] : `{${aux.join(',')}}`;
    const exc = exclude.length === 1 ? exclude[0] : `{${exclude.join(',')}}`;
    const uris = await vscode.workspace.findFiles(pat, exc, 4000);
    return uris.filter((u) => u.scheme === 'file').map((u) => u.fsPath);
  }

  /** 文件指纹：索引缓存用它判断"内容是否还是上次那份" */
  async stat(p: string): Promise<{ mtimeMs: number; size: number } | null> {
    try {
      const s = await vscode.workspace.fs.stat(vscode.Uri.file(p));
      return { mtimeMs: s.mtime, size: s.size };
    } catch {
      return null;
    }
  }

  async readFile(p: string): Promise<string> {
    // 优先使用编辑器中的内容（含未保存修改），保证追踪结果与眼前所见一致
    const doc = vscode.workspace.textDocuments.find(
      (d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, p),
    );
    if (doc) return doc.getText();

    const data = await vscode.workspace.fs.readFile(vscode.Uri.file(p));
    return Buffer.from(data).toString('utf8');
  }

  async exists(p: string): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(p));
      return true;
    } catch {
      return false;
    }
  }

  async resolveInclude(fromFile: string, includeName: string): Promise<string | null> {
    const candidates: string[] = [];
    candidates.push(path.join(path.dirname(fromFile), includeName));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(path.join(folder.uri.fsPath, includeName));
    }
    for (const c of candidates) {
      if (await this.exists(c)) return c;
    }
    return null;
  }
}

export function samePath(a: string, b: string): boolean {
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}
