import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import OpenAI from "openai";
import { systemPrompt } from "./src/systemPrompt.js";

dotenv.config();

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  throw new Error("Missing OPENAI_API_KEY in backend environment.");
}

const model = process.env.OPENAI_MODEL || "gpt-5-mini";
const port = Number(process.env.PORT || 3000);

const openai = new OpenAI({ apiKey });
const app = express();

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "domoticpet-chat-backend",
    model,
    timestamp: new Date().toISOString()
  });
});

app.post("/chat", async (req, res) => {
  try {
    const gatedReply = buildUnavailableFeatureReply(req.body?.message);
    if (gatedReply) {
      res.json({
        reply: gatedReply,
        responseId: null,
        model,
        handledLocally: true
      });
      return;
    }

    const response = await openai.responses.create(
      buildResponsesPayload(req.body, false)
    );

    res.json({
      reply: extractOutputText(response),
      responseId: response.id,
      model
    });
  } catch (error) {
    sendHttpError(res, error);
  }
});

app.post("/chat/stream", async (req, res) => {
  let responseId = null;
  let aggregatedText = "";

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const gatedReply = buildUnavailableFeatureReply(req.body?.message);
    if (gatedReply) {
      writeEvent(res, {
        type: "response_created",
        responseId: null
      });
      writeEvent(res, {
        type: "text_delta",
        delta: gatedReply
      });
      writeEvent(res, {
        type: "completed",
        responseId: null,
        outputText: gatedReply
      });
      return;
    }

    const stream = await openai.responses.create(
      buildResponsesPayload(req.body, true)
    );

    for await (const event of stream) {
      if (event.type === "response.created") {
        responseId = event.response?.id ?? event.response_id ?? null;
        writeEvent(res, {
          type: "response_created",
          responseId
        });
      }

      if (event.type === "response.output_text.delta" && event.delta) {
        aggregatedText += event.delta;
        writeEvent(res, {
          type: "text_delta",
          delta: event.delta
        });
      }

      if (event.type === "response.completed") {
        writeEvent(res, {
          type: "completed",
          responseId: event.response?.id ?? responseId,
          outputText: extractOutputText(event.response) || aggregatedText
        });
      }

      if (event.type === "response.failed") {
        writeEvent(res, {
          type: "error",
          message:
            event.response?.error?.message ||
            "OpenAI no pudo completar la respuesta."
        });
      }

      if (event.type === "error") {
        writeEvent(res, {
          type: "error",
          message: event.error?.message || "Error durante el streaming."
        });
      }
    }
  } catch (error) {
    writeEvent(res, {
      type: "error",
      message: getErrorMessage(error)
    });
  } finally {
    res.end();
  }
});

app.listen(port, () => {
  console.log(`DomoticPet chat backend listening on http://localhost:${port}`);
});

function buildResponsesPayload(body, stream) {
  const message = requireText(body?.message, "message");
  const previousResponseId = optionalText(body?.previousResponseId);
  const history = normalizeHistory(body?.history);
  const pets = normalizePets(body?.pets);
  const routines = normalizeRoutines(body?.routines, pets);
  const selectedPetId = normalizeOptionalNumber(body?.selectedPetId);
  const selectedPetName = optionalText(body?.selectedPetName);

  return {
    model,
    store: true,
    stream,
    instructions: buildInstructions({
      currentMessage: message,
      pets,
      routines,
      selectedPetId,
      selectedPetName
    }),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    input: [
      ...(!previousResponseId ? history : []),
      {
        role: "user",
        content: [{ type: "input_text", text: message }]
      }
    ]
  };
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .map((item) => {
      const role =
        item?.role === "assistant"
          ? "assistant"
          : item?.role === "user"
            ? "user"
            : null;
      const content = optionalText(item?.content);
      if (!role || !content) return null;

      return {
        role,
        content: [{ type: "input_text", text: content }]
      };
    })
    .filter(Boolean)
    .slice(-16);
}

function normalizePets(pets) {
  if (!Array.isArray(pets)) return [];

  return pets
    .map((pet) => {
      const id = normalizeOptionalNumber(pet?.id);
      const name = optionalText(pet?.name);
      if (!name) return null;

      return {
        id,
        name,
        type: optionalText(pet?.type),
        typeLabel: optionalText(pet?.typeLabel),
        customType: optionalText(pet?.customType),
        breed: optionalText(pet?.breed),
        ageValue: optionalText(pet?.ageValue),
        ageUnit: optionalText(pet?.ageUnit),
        ageLabel: optionalText(pet?.ageLabel),
        weightKg: optionalText(pet?.weightKg),
        weightLabel: optionalText(pet?.weightLabel),
        sex: optionalText(pet?.sex),
        isNeutered: typeof pet?.isNeutered === "boolean" ? pet.isNeutered : null,
        microchip: optionalText(pet?.microchip),
        personalityDescription: optionalText(pet?.personalityDescription),
        foodType: optionalText(pet?.foodType),
        foodBrands: optionalText(pet?.foodBrands) || optionalText(pet?.foodBrand),
        foodDescription:
          optionalText(pet?.foodDescription) ||
          [optionalText(pet?.foodProductName), optionalText(pet?.foodPresentation)]
            .filter(Boolean)
            .join(" ")
            .trim() ||
          null,
        foodCatalogMatches: normalizeFoodCatalogMatches(pet?.foodCatalogMatches),
        foodRestrictions: optionalText(pet?.foodRestrictions),
        allergies: optionalText(pet?.allergies),
        medications: optionalText(pet?.medications),
        medicalConditions: optionalText(pet?.medicalConditions),
        bloodType: optionalText(pet?.bloodType),
        emergencyContactName: optionalText(pet?.emergencyContactName),
        emergencyContactPhone: optionalText(pet?.emergencyContactPhone)
      };
    })
    .filter(Boolean);
}

function normalizeRoutines(routines, pets) {
  if (!Array.isArray(routines)) return [];

  return routines
    .map((routine) => {
      const id = normalizeOptionalNumber(routine?.id);
      const name = optionalText(routine?.name);
      if (!name) return null;

      const petId = normalizeOptionalNumber(routine?.petId);
      const petName =
        optionalText(routine?.petName) ||
        pets.find((pet) => pet.id === petId)?.name ||
        "General";

      return {
        id,
        name,
        petId,
        petName,
        time: optionalText(routine?.time),
        frequency: optionalText(routine?.frequency),
        notes: optionalText(routine?.notes),
        startDate: optionalText(routine?.startDate),
        endDate: optionalText(routine?.endDate),
        notificationsEnabled: Boolean(routine?.notificationsEnabled),
        alarmEnabled: Boolean(routine?.alarmEnabled),
        vibrationEnabled: Boolean(routine?.vibrationEnabled),
        isGeneral: Boolean(routine?.isGeneral) || petId === null,
        repeatIndefinitely:
          routine?.repeatIndefinitely === undefined
            ? true
            : Boolean(routine?.repeatIndefinitely)
      };
    })
    .filter(Boolean);
}

function buildInstructions({ currentMessage, pets, routines, selectedPetId, selectedPetName }) {
  const intent = analyzeMessageIntent(currentMessage);
  const selectedPet = resolveSelectedPet({
    pets,
    selectedPetId,
    selectedPetName,
    currentMessage
  });
  const ambiguityNote = buildAmbiguityNote({
    pets,
    selectedPet,
    currentMessage
  });

  const petsBlock = buildRelevantPetsBlock({
    pets,
    selectedPet,
    intent
  });

  const routinesBlock = buildRelevantRoutinesBlock({
    routines,
    selectedPet,
    intent
  });

  const focusBlock = selectedPet
    ? `Mascota principal para este turno: ${selectedPet.name}.`
    : null;

  return [
    systemPrompt,
    "",
    "Contexto real para este turno:",
    focusBlock,
    ambiguityNote,
    petsBlock,
    routinesBlock,
    "Lo que aparece aqui ya esta guardado en la app.",
    "Usa este contexto como memoria silenciosa y no como texto para repetir.",
    "No cites etiquetas, campos, nombres, rutinas ni horarios salvo que el usuario lo pida de forma explicita.",
    "No pidas confirmar datos que ya aparecen aqui.",
    intent.wantsRoutine
      ? "El usuario si esta preguntando por rutinas, asi que puedes usarlas si ayudan."
      : "No menciones rutinas en la respuesta salvo que el usuario las pida.",
    "No menciones inconsistencias ni datos extranos salvo que el usuario pida revisar la informacion.",
    intent.wantsFood ? buildFoodInstruction(selectedPet) : null,
    intent.isGreetingOnly ? buildGreetingInstruction() : null,
    "Si la informacion actual alcanza para responder, responde directo.",
    "Si falta algo importante, haz solo una pregunta corta."
  ]
    .filter(Boolean)
    .join("\n\n");
}

function resolveSelectedPet({ pets, selectedPetId, selectedPetName, currentMessage }) {
  if (selectedPetId !== null) {
    const byId = pets.find((pet) => pet.id === selectedPetId);
    if (byId) return byId;
  }

  if (selectedPetName) {
    const normalizedName = normalizeName(selectedPetName);
    const byName = pets.find((pet) => normalizeName(pet.name) === normalizedName);
    if (byName) return byName;
  }

  if (pets.length === 1) {
    return pets[0];
  }

  const mentionedPets = pets.filter((pet) =>
    normalizeName(currentMessage).includes(normalizeName(pet.name))
  );

  return mentionedPets.length === 1 ? mentionedPets[0] : null;
}

function analyzeMessageIntent(currentMessage) {
  const normalized = normalizeName(currentMessage);

  return {
    isGreetingOnly:
      /^(hola|holi|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|que tal|como estas)[!.? ]*$/.test(
        normalized
      ),
    wantsRoutine:
      /\b(rutina|rutinas|recordatorio|recordatorios|horario|horarios|alarma|alarmas|notificacion|notificaciones|pendiente|pendientes)\b/.test(
        normalized
      ),
    wantsSummary:
      /\b(que sabes|que me puedes decir|resumen|informacion|info|datos|perfil|ficha)\b/.test(
        normalized
      ),
    wantsFood:
      /\b(comida|alimentacion|alimento|alimentos|croqueta|croquetas|concentrado|dieta|comer|come|kcal|caloria|calorias|porcion|porciones|marca)\b/.test(
        normalized
      ),
    wantsMedical:
      /\b(alergia|alergias|medico|medica|medicas|condicion|condiciones|medicamento|medicamentos|salud|veterinario|veterinaria|sintoma|sintomas)\b/.test(
        normalized
      ),
    wantsHygiene:
      /\b(higiene|bano|bano|cepillado|cepillar|pelaje|unas|limpiar)\b/.test(
        normalized
      )
  };
}

function buildUnavailableFeatureReply(message) {
  const text = optionalText(message);
  if (!text) return null;

  const normalized = normalizeName(text);
  if (!requestsUnavailableCapability(normalized)) {
    return null;
  }

  return [
    "Esta funcion no esta disponible en la version actual de DomoticPet.",
    "Actualiza al plan Premium para acceder a funciones como:",
    "- internet en tiempo real",
    "- analisis de imagenes",
    "- chat por voz",
    "- funciones multimedia avanzadas."
  ].join("\n");
}

function requestsUnavailableCapability(normalizedMessage) {
  const patterns = [
    /\b(buscalo en internet|busca en internet|busca en google|buscalo en google|busca en la web|busqueda web|navega por internet|consulta internet)\b/,
    /\b(clima de hoy|temperatura de hoy|noticias de hoy|precio de hoy|actualizado en internet|informacion actualizada|en tiempo real)\b/,
    /\b(analiza esta foto|analiza esta imagen|mira esta foto|mira esta imagen|reconoce la raza por imagen|reconoce por foto|que ves en esta foto|que tiene en esta foto)\b/,
    /\b(te voy a mandar una imagen|te mandare una imagen|te voy a enviar una imagen|te voy a mandar una foto|te mandare una foto|subir una imagen|subir una foto)\b/,
    /\b(hablame por voz|quiero hablar por voz|chat por voz|respuesta por voz|audio de voz|te voy a mandar un audio|te mandare un audio|te voy a enviar un audio|escucha este audio)\b/,
    /\b(multimedia|video|analiza este video|mira este video|te voy a mandar un video|te mandare un video)\b/,
    /\b(busca veterinarias cerca|veterinarias cerca|veterinario cerca|veterinaria cerca|lugares cerca|cerca de mi)\b/,
    /\b(funcion premium|plan premium|premium)\b.*\b(internet|voz|imagen|imagenes|audio|multimedia)\b/
  ];

  return patterns.some((pattern) => pattern.test(normalizedMessage));
}

function buildRelevantPetsBlock({ pets, selectedPet, intent }) {
  if (intent.isGreetingOnly) {
    return null;
  }

  if (!pets.length) {
    return "No hay mascotas registradas en la app.";
  }

  if (selectedPet) {
    return [
      "Mascota relevante para responder:",
      formatPetContext(selectedPet, intent)
    ].join("\n");
  }

  if (intent.wantsSummary) {
    const overview = pets
      .slice(0, 6)
      .map((pet) => formatPetOverview(pet))
      .join("\n");

    return [
      "Mascotas registradas para referencia:",
      overview
    ].join("\n");
  }

  const count = pets.length;
  return `Hay ${count} mascota(s) disponibles para referencia interna. No muestres sus nombres ni sus datos salvo que el usuario los pida.`;
}

function buildRelevantRoutinesBlock({ routines, selectedPet, intent }) {
  if (!intent.wantsRoutine) {
    return null;
  }

  const relevantRoutines = routines.filter((routine) => {
    if (!selectedPet) return true;
    return routine.petId === selectedPet.id || routine.isGeneral;
  });

  if (!relevantRoutines.length) {
    return "No hay rutinas registradas para esta consulta.";
  }

  return [
    "Rutinas reales relevantes:",
    relevantRoutines
      .slice(0, 10)
      .map((routine, index) => formatRoutineContext(routine, index + 1))
      .join("\n")
  ].join("\n");
}

function buildAmbiguityNote({ pets, selectedPet, currentMessage }) {
  if (selectedPet) return null;

  const mentionedNames = pets
    .filter((pet) => normalizeName(currentMessage).includes(normalizeName(pet.name)))
    .map((pet) => pet.name);

  if (!mentionedNames.length) return null;

  const duplicatedNames = findDuplicatedPetNames(pets).filter((name) =>
    mentionedNames.some((mentioned) => normalizeName(mentioned) === normalizeName(name))
  );

  if (!duplicatedNames.length) return null;

  return `Atencion: hay varias mascotas con este nombre: ${duplicatedNames.join(", ")}. Si hace falta, pide una aclaracion corta.`;
}

function findDuplicatedPetNames(pets) {
  const counts = new Map();

  for (const pet of pets) {
    const normalized = normalizeName(pet.name);
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  return pets
    .map((pet) => pet.name)
    .filter((name, index, names) => {
      const normalized = normalizeName(name);
      return counts.get(normalized) > 1 && names.indexOf(name) === index;
    });
}

function formatPetContext(pet, intent) {
  const lines = [`Nombre: ${pet.name}`];

  addLine(lines, "Tipo", pet.typeLabel || pet.type || pet.customType);
  addLine(lines, "Raza", pet.breed);
  addLine(lines, "Edad", pet.ageLabel || buildAgeFallback(pet));
  addLine(lines, "Peso", pet.weightLabel || buildWeightFallback(pet));
  addLine(lines, "Sexo", pet.sex);
  addLine(lines, "Castrado o esterilizado", buildNeuteredLabel(pet.isNeutered));
  addLine(lines, "Personalidad", pet.personalityDescription);

  if (intent.wantsFood || intent.wantsSummary || intent.wantsMedical) {
    addLine(lines, "Tipo de comida", pet.foodType);
    addLine(lines, "Marca o marcas del alimento", pet.foodBrands);
    addLine(lines, "Descripcion general", pet.foodDescription);
    addFoodCatalogMatches(lines, pet.foodCatalogMatches);
    addLine(lines, "Restricciones alimentarias", pet.foodRestrictions);
    addLine(lines, "Alergias", pet.allergies);
    addLine(lines, "Medicamentos", pet.medications);
    addLine(lines, "Condiciones medicas", pet.medicalConditions);
  }

  if (intent.wantsSummary) {
    addLine(lines, "Microchip", pet.microchip);
    addLine(lines, "Tipo de sangre", pet.bloodType);
    addLine(lines, "Contacto de emergencia", buildEmergencyFallback(pet));
  }

  return lines.join("\n");
}

function formatPetOverview(pet) {
  const segments = [
    pet.name,
    pet.typeLabel || pet.type || pet.customType,
    pet.ageLabel || buildAgeFallback(pet)
  ].filter(Boolean);

  return `- ${segments.join(" - ")}`;
}

function formatRoutineContext(routine, index) {
  const detail = [
    `${index}. ${routine.name}`,
    routine.time,
    routine.frequency,
    routine.isGeneral ? "General" : routine.petName
  ].filter(Boolean);

  return `- ${detail.join(" - ")}`;
}

function buildAgeFallback(pet) {
  if (!pet.ageValue) return "";
  return pet.ageUnit ? `${pet.ageValue} ${pet.ageUnit}` : pet.ageValue;
}

function buildWeightFallback(pet) {
  return pet.weightKg ? `${pet.weightKg} kg` : "";
}

function buildEmergencyFallback(pet) {
  if (!pet.emergencyContactName && !pet.emergencyContactPhone) {
    return "";
  }

  return [pet.emergencyContactName, pet.emergencyContactPhone]
    .filter(Boolean)
    .join(" - ");
}

function normalizeFoodCatalogMatches(matches) {
  if (!Array.isArray(matches)) return [];

  return matches
    .map((match) => {
      const productId = optionalText(match?.productId);
      const brand = optionalText(match?.brand);
      const productName = optionalText(match?.productName);
      if (!productId || !brand || !productName) return null;

      return {
        productId,
        brand,
        productName,
        packLabel: optionalText(match?.packLabel),
        species: optionalText(match?.species),
        lifeStage: optionalText(match?.lifeStage),
        kcalPerKg: normalizeOptionalNumber(match?.kcalPerKg),
        kcalPerCup: normalizeOptionalNumber(match?.kcalPerCup),
        recommendedPortion: optionalText(match?.recommendedPortion),
        notes: optionalText(match?.notes),
        primaryUrl: optionalText(match?.primaryUrl)
      };
    })
    .filter(Boolean)
    .slice(0, 3);
}

function addFoodCatalogMatches(lines, matches) {
  if (!Array.isArray(matches) || !matches.length) return;

  lines.push("Coincidencias del catalogo local:");
  matches.forEach((match, index) => {
    const details = [
      `${index + 1}. ${match.brand} ${match.productName}`.trim(),
      match.packLabel,
      match.lifeStage ? `etapa: ${match.lifeStage}` : null,
      match.kcalPerKg ? `kcal/kg: ${match.kcalPerKg}` : null,
      match.kcalPerCup ? `kcal/taza: ${match.kcalPerCup}` : null
    ].filter(Boolean);

    lines.push(`- ${details.join(" - ")}`);
  });
}

function buildNeuteredLabel(value) {
  if (value === true) return "Si";
  if (value === false) return "No";
  return "";
}

function buildFoodInstruction(selectedPet) {
  if (!selectedPet) {
    return "Si faltan datos del alimento para responder bien, pide solo la marca y, si hace falta, la linea o descripcion general del producto.";
  }

  if (Array.isArray(selectedPet.foodCatalogMatches) && selectedPet.foodCatalogMatches.length === 1) {
    const match = selectedPet.foodCatalogMatches[0];
    if (match.kcalPerKg || match.kcalPerCup) {
      return "Hay una coincidencia clara en el catalogo local y trae energia verificada. Puedes usarla como apoyo interno para orientar una porcion de forma simple, sin mostrar formulas ni tecnicismos.";
    }
  }

  if (Array.isArray(selectedPet.foodCatalogMatches) && selectedPet.foodCatalogMatches.length > 1) {
    return "Hay varias coincidencias posibles en el catalogo local. No adivines cual es. Si hace falta, pide solo una aclaracion corta sobre la linea o el nombre exacto del producto.";
  }

  if (selectedPet.foodBrands && !selectedPet.foodDescription) {
    return "Solo hay una marca general del alimento y no alcanza para identificar bien el producto o la linea. No inventes calorias. Pide solo una aclaracion corta sobre el nombre exacto, la linea o la descripcion del alimento.";
  }

  return "Si faltan datos para responder bien sobre comida, pide solo el dato faltante mas importante en una pregunta corta y sin formulas tecnicas.";
}

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function normalizeOptionalNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function optionalText(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
}

function requireText(value, fieldName) {
  const text = optionalText(value);
  if (!text) {
    throw new HttpError(400, `${fieldName} is required.`);
  }
  return text;
}

function safeValue(value) {
  return optionalText(value) || "No registrado";
}

function addLine(lines, label, value) {
  const text = optionalText(value);
  if (!text) return;
  lines.push(`${label}: ${text}`);
}

function buildGreetingInstruction() {
  return 'Para este turno, responde exactamente asi: "¡Hola! Soy IAn, tu asistente de DomoticPet. ¿En qué te ayudo hoy?"';
}

function extractOutputText(response) {
  if (!response) return "";
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const output = Array.isArray(response.output) ? response.output : [];
  const chunks = [];

  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (part?.type === "output_text" && typeof part.text === "string") {
        chunks.push(part.text);
      }
    }
  }

  return chunks.join("").trim();
}

function writeEvent(res, payload) {
  res.write(`${JSON.stringify(payload)}\n`);
}

function sendHttpError(res, error) {
  const status = error instanceof HttpError ? error.status : error?.status || 500;
  res.status(status).json({
    error: "chat_failed",
    message: getErrorMessage(error)
  });
}

function getErrorMessage(error) {
  if (error instanceof HttpError) {
    return error.message;
  }

  if (error?.status && error?.message) {
    return `${error.status}: ${error.message}`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected backend error";
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
