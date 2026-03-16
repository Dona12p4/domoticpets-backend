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
```

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

- `GET /health`
- `POST /chat`
- `POST /chat/stream`

`/chat/stream` devuelve NDJSON para que Android pueda ir pintando la respuesta progresivamente.

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

## Notas

- La API key solo se lee desde `process.env.OPENAI_API_KEY`
- No se guarda en Kotlin, `strings.xml` ni `BuildConfig`
- La app Android en desarrollo apunta por defecto a `http://10.0.2.2:3000`
- Si usas un telefono fisico, cambia la URL del backend en `gradle.properties`
