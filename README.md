# Invictus GO — AI Аудит продаж

## Переменные окружения (Railway → Variables)

```
AMO_TOKEN=ваш_токен_амо
AMO_DOMAIN=invictusgo.amocrm.ru
ANTHROPIC_KEY=sk-ant-...
WAZZUP_KEY=ab1b2cc067e44ca29305dbc49323b932
```

## Вебхуки после деплоя

**Wazzup переписки:**
```
POST https://ВАШ-ДОМЕН.railway.app/webhook/wazzup
```

**Звонки (от Yandex транскрипции):**
```
POST https://ВАШ-ДОМЕН.railway.app/webhook/call

Body:
{
  "call_id": "уникальный ID звонка",
  "manager_name": "Фуад",
  "lead_id": "30776921",
  "contact_phone": "77071234567",
  "duration": 180,
  "direction": "in",
  "transcript": "Менеджер: Добрый день...\nКлиент: ...",
  "called_at": 1773237680
}
```

## Деплой на Railway

1. Загрузите папку на GitHub
2. Railway → New Project → Deploy from GitHub
3. Добавьте переменные окружения
4. Готово!
