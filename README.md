# aleAnimiecV2

Synchronised video streaming – admin uploads & plays, viewers watch in sync.

Źródła obrazu: wgrany plik, bezpośredni link do wideo (przez proxy) oraz
osadzony player (YouTube, Twitch). Do wgranych plików i linków można dołożyć
napisy — patrz [Napisy](#napisy).

Interfejs jest responsywny (breakpointy 640 px i 380 px); na telefonie pigułka
statusu znika, bo ten sam stan pokazuje pasek pod odtwarzaczem.

Widz widzi w nagłówku licznik połączonych z pokojem (razem z adminem, który też
ogląda) oraz status synchronizacji, w tym **Buforowanie…**, gdy jego własne
odtwarzanie się zatnie — zamiast cichego wypadnięcia z synchronizacji.

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

## Testy

```bash
npm test
```

`node --test`, bez zewnętrznych zależności. Pokrywają konwersję napisów
(`lib/subtitle-format.js`) i parser WebVTT (`public/subtitles.js`) — od surowych
bajtów uploadu po gotowe cue, razem z dekodowaniem Windows-1250.

Otwórz `http://localhost:3000` (viewer) lub `http://localhost:3000/admin.html` (admin).

`public/config.js` sam wykrywa localhost, więc lokalnie nie trzeba nic w nim zmieniać –
frontend rozmawia z serwerem, który go wysłał.

## Deploy

### Backend na Render

1. Połącz repo z Render.com (Web Service).
2. Render automatycznie użyje `render.yaml`.
3. Ustaw zmienne środowiskowe w dashboardzie Render:
   - `ADMIN_PASSWORD` – hasło admina
   - `FRONTEND_URL` – URL frontendu na Vercel (np. `https://ale-animiec.vercel.app`)

> **Uwaga:** `FRONTEND_URL` **bez ukośnika na końcu**. Ukośnik trafia do nagłówka
> `Access-Control-Allow-Origin`, przeglądarka go wtedy nie dopasuje i wszystkie
> zapytania cross-origin (w tym uploady) są blokowane bez czytelnego komunikatu.
> Można podać kilka originów po przecinku.

> **Dysk na Render:** trwałe dyski (sekcja `disk:` w `render.yaml`) są dostępne
> tylko na płatnych planach. Na planie `free` katalog `uploads/` jest efemeryczny –
> pliki znikają przy każdym restarcie / deployu. Stan odtwarzacza jest zapisywany
> do `uploads/.state.json`, więc na free tierze też nie przetrwa restartu.

### Frontend na Vercel

1. Połącz repo z Vercel.
2. Ustaw:
   - **Output Directory**: `public`
   - **Framework Preset**: Other
3. Edytuj `public/config.js` i ustaw adres backendu z Render:
   ```js
   window.BACKEND_URL = isLocal ? '' : 'https://ale-animiec-backend.onrender.com';
   ```

### Socket.io na Vercel

Vercel nie obsługuje WebSocket na serverless – dlatego backend Socket.io jest na Render. Frontend na Vercel łączy się z backendem przez `BACKEND_URL`.

## Zmienne środowiskowe

| Zmienna | Gdzie | Opis |
|---------|-------|------|
| `PORT` | Backend | Port serwera (domyślnie 3000, Render ustawia automatycznie) |
| `ADMIN_PASSWORD` | Backend | Hasło do panelu admina |
| `FRONTEND_URL` | Backend | Origin(y) frontendu dla CORS, po przecinku, bez ukośnika na końcu |
| `ALLOW_ANY_ORIGIN` | Backend | `1` = akceptuj dowolny origin (np. podglądy deployów Vercel) |
| `MAX_UPLOAD_GB` | Backend | Limit rozmiaru wgrywanego pliku (domyślnie 4) |
| `TRUST_PROXY` | Backend | Liczba zaufanych proxy przed aplikacją (na Render wykrywane automatycznie) |
| `BACKEND_URL` | Frontend (`config.js`) | URL backendu dla Socket.io i API |

Gdy `FRONTEND_URL` jest puste, dozwolone są wszystkie originy.

## API

| Metoda | Ścieżka | Opis |
|--------|---------|------|
| `GET` | `/health` | Health check (używany też przez self-ping) |
| `POST` | `/auth` | Weryfikacja hasła admina; zwraca `maxUploadBytes` |
| `POST` | `/upload` | Wgranie pliku video (pole `video`) |
| `GET` | `/videos` | Lista plików w `uploads/` |
| `DELETE` | `/videos/:name` | Usunięcie pliku z serwera |
| `POST` | `/subtitles` | Wgranie napisów (pole `subtitle`, .srt lub .vtt) |
| `GET` | `/subtitles` | Lista wgranych napisów |
| `DELETE` | `/subtitles/:name` | Usunięcie napisów |
| `GET` | `/proxy?url=…` | Streamowanie zewnętrznego URL (omija CORS, blokuje SSRF) |

Wszystkie poza `/health` i `/proxy` wymagają nagłówka `x-admin-password`.

## Ochrona przed zgadywaniem hasła

Licznik nieudanych prób jest wspólny dla **wszystkich** miejsc, które sprawdzają
hasło — endpointów HTTP i zdarzeń `admin:*` po sockecie. Limit tylko na `/auth`
byłby pozorny, bo to samo hasło otwiera `/videos`, `/upload` i `/subtitles`.

- 8 nieudanych prób w oknie 15 minut → blokada na 60 s (odpowiedź `429`
  z nagłówkiem `Retry-After`, po sockecie `admin:error`).
- Każda kolejna blokada z rzędu podwaja czas, maksymalnie do 30 minut.
- Poprawne hasło kasuje historię prób danego adresu.
- Każda odrzucona próba po HTTP jest dodatkowo opóźniona o 400 ms.
- Panel admina pokazuje odliczanie i blokuje formularz na czas kary.

Logika siedzi w `lib/rate-limit.js` (zegar wstrzykiwany, więc jest testowalna
bez czekania) i ma własne testy.

> **Za proxy ustaw `TRUST_PROXY`.** Bez tego wszystkie żądania wyglądają, jakby
> przychodziły z jednego adresu — cały internet trafia do wspólnego kubełka
> i jeden atakujący zablokuje prawdziwego admina. Na Render wykrywamy to
> automatycznie (zmienne `RENDER*`) i ufamy jednemu przeskokowi, co sprawia, że
> `req.ip` to adres dopisany przez ich edge, a więc nie do podrobienia przez
> klienta.

## Panel admina

Odtwarzacz w panelu nie ma natywnych `controls` — miałby własne, nieskoordynowane
z pokojem. Zamiast tego jest własny pasek przewijania: klikalny i przeciągalny
(również dotykiem), z zaznaczonym zbuforowanym zakresem, plus przyciski
**−10 s / +10 s** i strzałki ← → po sfokusowaniu paska (±5 s). Każde przewinięcie
leci do widzów jako `admin:seek`; w trakcie przeciągania heartbeat serwera nie
przestawia pozycji admina.

Dla osadzonych playerów pasek jest ukryty — YouTube sterujemy przez jego własne
API, a Twitcha wcale.

## Napisy

Admin wgrywa plik **.srt** lub **.vtt**; serwer normalizuje wszystko do WebVTT
i rozsyła wybraną ścieżkę do widzów w `sync:state`, więc każdy widzi te same
linie w tym samym momencie.

- **Kodowanie**: polskie `.srt` bywają zapisane w Windows-1250. Serwer najpierw
  próbuje UTF-8, a gdy plik nie jest poprawnym UTF-8, dekoduje go jako
  Windows-1250 — bez tego polskie znaki zamieniają się w krzaki.
- **Synchronizacja (offset)**: suwak w panelu admina przesuwa napisy w czasie.
  Wartość dodatnia = napisy później, ujemna = wcześniej. Zmiana leci osobnym
  zdarzeniem `subtitles:offset`, więc **nie przerywa i nie przewija filmu**.
  Admin widzi napisy u siebie z tym samym przesunięciem, więc może je ustawić
  „na oko" na obrazie.
- **Widz** może wyłączyć napisy lokalnie przyciskiem **CC** (wybór zapamiętywany
  w `localStorage`); nie wpływa to na pozostałych.
- Konwersja i parser mają testy jednostkowe — patrz [Testy](#testy).
- Napisy renderujemy własną warstwą, a nie `<track>` — dzięki temu offset działa
  natychmiast bez przeładowania i nie zależy od `crossorigin` przy backendzie
  na innej domenie. Rysowanie jest napędzane interwałem 100 ms, bo
  `requestAnimationFrame` zatrzymuje się w karcie w tle.
- Napisy działają dla wgranych plików i bezpośrednich linków do wideo.
  Dla osadzonych playerów (YouTube, Twitch) nie ma gdzie ich narysować.

## Zdarzenia Socket.io

**Serwer → klient:** `sync:state`, `video:loaded`, `video:cleared`,
`viewers:count`, `subtitles:changed`, `subtitles:offset`, `admin:error`

**Klient → serwer:** `ping:time` (kalibracja zegara), `viewer:resync`,
oraz komendy admina (każda z `password`): `admin:play`, `admin:pause`, `admin:seek`,
`admin:load`, `admin:load-url`, `admin:load-embed`, `admin:clear`,
`admin:subtitle`, `admin:subtitle-offset`.
