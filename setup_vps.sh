#!/bin/bash
# setup_vps.sh — запустить один раз после получения VPS
# Запуск: bash setup_vps.sh

set -e
echo "=== Установка Node.js 20 ==="
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "=== Установка nginx ==="
apt-get install -y nginx

echo "=== Установка PM2 ==="
npm install -g pm2

echo "=== Клонирование репозитория ==="
# Замените на ваш репозиторий
git clone https://github.com/ВАШ_ЛОГИН/ВАШ_РЕПО.git /opt/dasbord
cd /opt/dasbord

echo "=== Установка зависимостей ==="
npm install --production

echo "=== Создание .env ==="
echo "Введите данные для .env файла:"
read -p "GITHUB_OWNER: " OWNER
read -p "GITHUB_REPO: "  REPO
read -p "GITHUB_TOKEN: " TOKEN

cat > .env << EOF
GITHUB_OWNER=$OWNER
GITHUB_REPO=$REPO
GITHUB_TOKEN=$TOKEN
PORT=3000
EOF

echo "=== Настройка nginx ==="
cp nginx.conf /etc/nginx/sites-available/dasbord
ln -sf /etc/nginx/sites-available/dasbord /etc/nginx/sites-enabled/dasbord
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "=== Запуск через PM2 ==="
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root

echo ""
echo "✅ Готово! Дашборд запущен."
echo "   Открыть: http://$(curl -s ifconfig.me)"
echo ""
echo "Полезные команды:"
echo "  pm2 status          — статус процесса"
echo "  pm2 logs dasbord    — логи"
echo "  pm2 restart dasbord — перезапуск"
echo "  cd /opt/dasbord && git pull && pm2 restart dasbord  — обновление"
