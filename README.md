# aleAnimiecV2

Synchronised video streaming – admin uploads & plays, viewers watch in sync.

## Architektura

- **Backend** (Node.js / Express / Socket.io) → deploy na **Render.com**
- **Frontend** (statyczne pliki HTML/CSS/JS) → deploy na **Vercel.com**

## Lokalne uruchomienie

```bash
cp .env.example .env
# Ustaw ADMIN_PASSWORD w .env
npm install
npm start        # lub npm run dev (watch mode)
```

Otwórz `http://localhost:3000` (viewer) lub `http://localhost:3000/admin.html` (admin).

## Deploy

### Backend na Render

1. Połącz repo z Render.com (Web Service).
2. Render automatycznie użyje `render.yaml`.
3. Ustaw zmienne środowiskowe w dashboardzie Render:
   - `ADMIN_PASSWORD` – hasło admina
   - `FRONTEND_URL` – URL frontendu na Vercel (np. `https://ale-animiec.vercel.app`)

### Frontend na Vercel

1. Połącz repo z Vercel.
2. Ustaw:
   - **Output Directory**: `public`
   - **Framework Preset**: Other
3. Edytuj `public/config.js` i ustaw `BACKEND_URL` na URL backendu z Render:
   ```js
   window.BACKEND_URL = 'https://ale-animiec-backend.onrender.com';
   ```
   Alternatywnie: użyj zmiennej środowiskowej Vercel i build script, ale dla prostoty wystarczy edycja pliku.

### Socket.io na Vercel

Vercel nie obsługuje WebSocket na serverless – dlatego backend Socket.io jest na Render. Frontend na Vercel łączy się z backendem przez `BACKEND_URL`.

## Zmienne środowiskowe

| Zmienna | Gdzie | Opis |
|---------|-------|------|
| `PORT` | Backend (Render) | Port serwera (domyślnie 3000, Render ustawia automatycznie) |
| `ADMIN_PASSWORD` | Backend (Render) | Hasło do panelu admina |
| `FRONTEND_URL` | Backend (Render) | URL frontendu (CORS) |
| `BACKEND_URL` | Frontend (`config.js`) | URL backendu dla Socket.io i API |