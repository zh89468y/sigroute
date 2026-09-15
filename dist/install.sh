#!/usr/bin/env bash
# SigRoute 安装脚本（Linux / macOS）
# 用法：bash install.sh

set -u

cd "$(dirname "$0")" || exit 1

echo
echo "  SigRoute - FPGA 信号路由追踪   安装程序"
echo "  ============================================================"
echo

VSIX="$(ls -1 ./*.vsix 2>/dev/null | head -n1)"
if [ -z "$VSIX" ]; then
  echo "  [错误] 本目录下没有 .vsix 文件。"
  echo "  请把本脚本与 sigroute-x.x.x.vsix 放在同一个目录下再运行。"
  echo
  exit 1
fi
echo "  安装包: $(basename "$VSIX")"
echo

# ---- 定位 code 命令 ----
CODE=""
for candidate in code code-insiders codium; do
  if command -v "$candidate" >/dev/null 2>&1; then
    CODE="$candidate"
    break
  fi
done

# macOS 常见路径
if [ -z "$CODE" ]; then
  for p in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
  do
    if [ -x "$p" ]; then
      CODE="$p"
      break
    fi
  done
fi

if [ -z "$CODE" ]; then
  echo "  [需要手动安装] 没有找到 VS Code 命令行工具。"
  echo
  echo "  请改用下面任一方式："
  echo
  echo "    方式 1：打开 VS Code -> 扩展面板(Ctrl+Shift+X)"
  echo "            -> 右上角 \"...\" 菜单 -> \"从 VSIX 安装...\""
  echo "            -> 选择本目录下的 .vsix 文件。"
  echo
  echo "    方式 2：在 VS Code 里按 Cmd/Ctrl+Shift+P，执行"
  echo "            Shell Command: Install 'code' command in PATH"
  echo "            然后重新运行本脚本。"
  echo
  exit 2
fi

echo "  使用: $CODE"
echo
echo "  正在安装..."
echo

# 先卸载旧版本（首次安装会静默失败，正常）
"$CODE" --uninstall-extension sigroute.sigroute >/dev/null 2>&1 || true

if ! "$CODE" --install-extension "$VSIX" --force; then
  echo
  echo "  [失败] 安装命令返回了错误，请改用上面的方式 1 手动安装。"
  echo
  exit 3
fi

echo
echo "  ============================================================"
echo "  安装完成！"
echo
echo "  用法：在 VS Code 里打开你的 FPGA 工程，然后"
echo "    - 光标放在信号上按 Ctrl+Alt+T   追踪上游+下游"
echo "    - 鼠标悬停信号                   看位宽/驱动源/负载/上级连接"
echo "    - Shift+F12                      查找引用"
echo "    - 右键菜单                      追踪 / 显示框图 / 跳到父层连接处"
echo
echo "  首次打开工程会自动建立索引（大型工程约 1 秒），"
echo "  状态栏右下角会显示已索引的模块数。"
echo "  ============================================================"
echo
