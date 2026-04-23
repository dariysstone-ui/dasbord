# Настройка дашборда: GitHub Releases + Vercel

## Структура репозитория

```
your-repo/
  index.html        ← новый дашборд
  api/
    index.js        ← новый API
  vercel.json       ← без изменений
```

---

## Шаг 1 — Создать GitHub Releases с CSV-файлами

Для каждого года создаём отдельный Release:

### Для 2025 года:
1. Открыть репозиторий на GitHub
2. Справа найти раздел **Releases** → нажать **Create a new release**
3. Поле **Choose a tag** → ввести `data-2025` → нажать **Create new tag**
4. Поле **Release title** → ввести `Data 2025`
5. Раздел **Attach binaries** (внизу) → перетащить файл `2025.csv`
6. Нажать **Publish release**

### Для 2026 года:
- Tag: `data-2026`, Title: `Data 2026`, Файл: `2026.csv`

После создания файлы доступны по URL:
```
https://github.com/ВАШ_ЮЗЕР/ВАШ_РЕПО/releases/download/data-2025/2025.csv
https://github.com/ВАШ_ЮЗЕР/ВАШ_РЕПО/releases/download/data-2026/2026.csv
```

---

## Шаг 2 — Создать GitHub Personal Access Token

1. GitHub → аватар → **Settings** → **Developer settings**
2. **Personal access tokens** → **Tokens (classic)** → **Generate new token**
3. Note: `vercel-dashboard`, Expiration: **No expiration**
4. Scope: только **`public_repo`**
5. **Generate token** → скопировать (показывается один раз!)

---

## Шаг 3 — Добавить переменные в Vercel

Settings → Environment Variables → добавить три:

| Name | Value |
|------|-------|
| `GITHUB_OWNER` | ваш GitHub username |
| `GITHUB_REPO` | название репозитория |
| `GITHUB_TOKEN` | токен из шага 2 |

---

## Шаг 4 — Обновить GitHub

```bash
git add index.html api/index.js
git commit -m "feat: switch to GitHub Releases CSV"
git push
```

---

## Обновление 2026.csv

### Вручную:
1. Репозиторий → **Releases** → найти **Data 2026** → Edit (карандаш)
2. Удалить старый `2026.csv` → загрузить новый → **Update release**

### Автоматически через GitHub Actions:
Создать `.github/workflows/update-data.yml`:

```yaml
name: Update 2026 data
on:
  schedule:
    - cron: '0 6 * * *'   # каждый день 9:00 МСК
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Upload to Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: data-2026
          files: data/2026.csv
          token: ${{ secrets.GITHUB_TOKEN }}
```

Файл `data/2026.csv` должен лежать в репозитории и обновляться коммитом.

---

## Лимиты GitHub

| Параметр | Лимит |
|----------|-------|
| Размер файла в Release | 2 ГБ |
| Запросов/час с токеном | 5 000 |
| Запросов/час без токена | 60 |
