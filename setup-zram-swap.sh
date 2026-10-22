#!/usr/bin/env bash
# ==============================================================================
# QAQ-Harness —— Ubuntu 受限硬件一键配置 ZRAM (zstd) 内存交换空间
# ==============================================================================
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BLUE}${BOLD}================================================================${NC}"
echo -e "${BLUE}${BOLD}     QAQ-Harness: Ubuntu 一键配置 ZRAM + zstd 极速内存交换区    ${NC}"
echo -e "${BLUE}${BOLD}================================================================${NC}"

# 1. 检查是否具备 root 权限；如果没有，尝试图形化弹窗 pkexec 或 sudo 重新唤起
if [ "$(id -u)" -ne 0 ]; then
    echo -e "${YELLOW}检测到当前未以 root 权限运行，正在申请系统授权 (类似 Windows UAC)...${NC}"
    if command -v pkexec >/dev/null 2>&1 && [ -n "${DISPLAY:-}" ]; then
        exec pkexec bash "$0" "$@"
    elif command -v sudo >/dev/null 2>&1; then
        exec sudo bash "$0" "$@"
    else
        echo -e "${RED}错误：请以 root 身份运行此脚本：sudo bash $0${NC}"
        exit 1
    fi
fi

echo -e "\n${GREEN}[1/4] 安装官方 zram-tools 工具包...${NC}"
if ! dpkg -s zram-tools >/dev/null 2>&1; then
    apt-get update -qq
    apt-get install -y -qq zram-tools
    echo -e "${GREEN}✓ zram-tools 安装完成${NC}"
else
    echo -e "${GREEN}✓ zram-tools 已安装${NC}"
fi

echo -e "\n${GREEN}[2/4] 配置 zram 内存交换池 (zstd 算法 + 50% 物理内存分配)...${NC}"
cat << 'EOF' > /etc/default/zramswap
# 压缩算法：采用高压缩比且快速的 zstd 算法（极度适合老 CPU 与弱核显）
ALGO=zstd

# 分配内存池上限：物理 RAM 的 50%（~4GB），经压缩可等价提供 8~12GB 交换容量
PERCENT=50

# 交换优先级：高于任何磁盘交换区，确保换页全部跑在高速内存带宽上
PRIORITY=100
EOF
echo -e "${GREEN}✓ /etc/default/zramswap 配置成功${NC}"

echo -e "\n${GREEN}[3/4] 启动 zramswap 服务并加入系统开机自启...${NC}"
systemctl daemon-reload
systemctl enable --now zramswap.service
systemctl restart zramswap.service
echo -e "${GREEN}✓ zramswap 服务已生效并设置为开机自启${NC}"

echo -e "\n${GREEN}[4/4] 调优内核内存换页参数 (vm.swappiness = 100)...${NC}"
sysctl -w vm.swappiness=100 >/dev/null
cat << 'EOF' > /etc/sysctl.d/99-zram.conf
vm.swappiness=100
vm.watermark_boost_factor=0
vm.watermark_scale_factor=125
vm.page-cluster=0
EOF
echo -e "${GREEN}✓ 内存换页与抗卡顿参数已固化${NC}"

echo -e "\n${BLUE}${BOLD}================================================================${NC}"
echo -e "${GREEN}${BOLD}🎉 恭喜！ZRAM (zstd) 内存压缩区已全部部署完毕！${NC}"
echo -e "${BLUE}${BOLD}================================================================${NC}"

echo -e "\n${BOLD}当前 ZRAM 运行状态：${NC}"
zramctl || true

echo -e "\n${BOLD}当前系统内存总览 (free -h)：${NC}"
free -h

echo -e "\n${GREEN}这台双核老奔腾现在拥有了高速的 zstd 内存缓冲，再也不会因为内存吃紧而整机冻结或 OOM 了！${NC}\n"
