# DomoticPet Chat Backend

Backend real para `Chat IA` de DomoticPet usando la Responses API de OpenAI sin exponer la API key en Android.

## Requisitos

- Node.js 18.18 o superior
- Una API key valida de OpenAI puesta solo en variables de entorno

## Archivo de entorno

Tu archivo real debe crearse aqui:

`C:\Users\USER\AndroidStudioProjects\DomoticPets\backend\.env`

No esta versionado y no debes ponerlo en Android.

1. Copia `.env.example` a `.env`
2. Edita `.env` y completa tu clave real

Ejemplo base:

```env
OPENAI_API_KEY=your_key_here
PORT=3000
```

Variable opcional:

```env
OPENAI_MODEL=gpt-5-mini
FIREBASE_RTDB_BASE_URL=https://domoticpets-default-rtdb.firebaseio.com
```

`FIREBASE_RTDB_BASE_URL` permite que el backend complemente el contexto del chat con el ultimo estado disponible de `bebedero`, `comedero` y `arenero` directamente desde Firebase.

## Instalar dependencias

```bash
npm install
```

## Ejecutar en Windows

En PowerShell:

```powershell
cd C:\Users\USER\AndroidStudioProjects\DomoticPets\backend
Copy-Item .env.example .env
npm install
npm run dev
```

## Ejecutar en modo normal

```bash
npm start
```

## Endpoints

- `GET /`
- `GET /health`
- `POST /chat`
- `POST /chat/stream`

`/chat/stream` devuelve NDJSON para que Android pueda ir pintando la respuesta progresivamente.

Si el backend esta desplegado en Render con la URL publica:

`https://domoticpets-backend.onrender.com`

entonces los endpoints finales quedan asi:

- `https://domoticpets-backend.onrender.com/`
- `https://domoticpets-backend.onrender.com/health`
- `https://domoticpets-backend.onrender.com/chat`
- `https://domoticpets-backend.onrender.com/chat/stream`

## Request esperado en /chat

```json
{
  "message": "Que comida le doy a Mimi?",
  "history": [
    { "role": "user", "content": "Hola" },
    { "role": "assistant", "content": "Hola, soy IAn." }
  ],
  "pets": [
    {
      "id": 1,
      "name": "Mimi",
      "typeLabel": "Gato",
      "ageLabel": "2 anos",
      "weightLabel": "3.8 kg",
      "allergies": "",
      "medicalConditions": ""
    }
  ],
  "routines": [
    {
      "id": 5,
      "name": "Dar comida",
      "petId": 1,
      "petName": "Mimi",
      "time": "08:00",
      "frequency": "Diario"
    }
  ],
  "selectedPetId": 1,
  "selectedPetName": "Mimi",
  "previousResponseId": "resp_123"
}
```

## Response esperado en /chat

```json
{
  "reply": "Respuesta real del asistente",
  "responseId": "resp_abc123",
  "model": "gpt-5-mini"
}
```

## Android

La app debe enviar el request al endpoint publico:

`https://domoticpets-backend.onrender.com/chat`

Y para streaming:

`https://domoticpets-backend.onrender.com/chat/stream`

## Notas

- La API key solo se lee desde `process.env.OPENAI_API_KEY`
- No se guarda en Kotlin, `strings.xml` ni `BuildConfig`
- Render necesita escuchar en `process.env.PORT || 3000`
- El servidor escucha en `0.0.0.0`
- La app Android puede apuntar a Render, emulador o WiFi local segun `gradle.properties`
