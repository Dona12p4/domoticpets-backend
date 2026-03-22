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
const host = "0.0.0.0";
const realtimeDbBaseUrl = optionalText(process.env.FIREBASE_RTDB_BASE_URL);

const openai = new OpenAI({ apiKey });
const app = express();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.use((error, _req, res, next) => {
  if (error?.type === "entity.too.large") {
    res.status(413).json({
      error: "payload_too_large",
      message: "La consulta fue demasiado pesada para el chat. Intenta de nuevo con menos contexto o sin foto."
    });
    return;
  }

  if (error instanceof SyntaxError && "body" in error) {
    res.status(400).json({
      error: "invalid_json",
      message: "El cuerpo JSON no es valido."
    });
    return;
  }

  next(error);
});

app.get("/", (_req, res) => {
  res.status(200).send("Backend DomoticPets activo");
});

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
    const response = await openai.responses.create(
      await buildResponsesPayload(req.body, false)
    );

    res.json({
      reply: extractOutputText(response),
      responseId: response.id,
      model
    });
  } catch (error) {
    sendHttpError(res, error, "/chat");
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
    const stream = await openai.responses.create(
      await buildResponsesPayload(req.body, true)
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
          message: getClientSafeErrorMessage(event.response?.error)
        });
      }

      if (event.type === "error") {
        writeEvent(res, {
          type: "error",
          message: getClientSafeErrorMessage(event.error)
        });
      }
    }
  } catch (error) {
    logServerError(error, "/chat/stream");
    writeEvent(res, {
      type: "error",
      message: getClientSafeErrorMessage(error)
    });
  } finally {
    res.end();
  }
});

app.listen(port, host, () => {
  console.log(`DomoticPet chat backend listening on http://${host}:${port}`);
});

async function buildResponsesPayload(body, stream) {
  const message = requireText(body?.message, "message");
  const previousResponseId = optionalText(body?.previousResponseId);
  const history = normalizeHistory(body?.history);
  const pets = normalizePets(body?.pets);
  const routines = normalizeRoutines(body?.routines, pets);
  const devices = await enrichDevicesWithRealtimeState(normalizeDevices(body?.devices));
  const userProfile = normalizeUserProfile(body?.userProfile);
  const appStats = normalizeAppStats(body?.appStats);
  const notificationSettings = normalizeNotificationSettings(body?.notificationSettings);
  const recentNotifications = normalizeRecentNotifications(body?.recentNotifications);
  const selectedPetId = normalizeOptionalNumber(body?.selectedPetId);
  const selectedPetName = optionalText(body?.selectedPetName);
  const selectedPetImage = normalizeSelectedPetImage(body?.selectedPetImage);

  return {
    model,
    store: true,
    stream,
    instructions: buildInstructions({
      currentMessage: message,
      pets,
      routines,
      devices,
      userProfile,
      appStats,
      notificationSettings,
      recentNotifications,
      selectedPetId,
      selectedPetName,
      selectedPetImage
    }),
    ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
    input: [
      ...(!previousResponseId ? history : []),
      {
        role: "user",
        content: buildUserInputContent(message, selectedPetImage)
      }
    ]
  };
}

function buildUserInputContent(message, selectedPetImage) {
  const content = [{ type: "input_text", text: message }];

  if (selectedPetImage) {
    content.push({
      type: "input_image",
      image_url: selectedPetImage.dataUrl,
      detail: selectedPetImage.detail
    });
  }

  return content;
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
        hasPhoto: Boolean(pet?.hasPhoto),
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

function normalizeSelectedPetImage(image) {
  if (!image || typeof image !== "object") return null;

  const dataUrl = optionalText(image?.dataUrl);
  if (!dataUrl || !/^data:image\/[a-zA-Z0-9.+-]+;base64,/.test(dataUrl)) {
    return null;
  }

  const detail = ["low", "high", "auto"].includes(optionalText(image?.detail))
    ? optionalText(image?.detail)
    : "high";

  return {
    petId: normalizeOptionalNumber(image?.petId),
    petName: optionalText(image?.petName),
    dataUrl,
    detail
  };
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

function normalizeDevices(devices) {
  if (!Array.isArray(devices)) return [];

  return devices
    .map((device) => {
      const id = normalizeOptionalNumber(device?.id);
      const customName = optionalText(device?.customName);
      const type = optionalText(device?.type);
      const typeLabel = optionalText(device?.typeLabel);
      if (id === null || !customName || !type || !typeLabel) return null;

      return {
        id,
        customName,
        type,
        typeLabel,
        bluetoothName: optionalText(device?.bluetoothName),
        wifiSsid: optionalText(device?.wifiSsid),
        ipAddress: optionalText(device?.ipAddress),
        isOnline: Boolean(device?.isOnline),
        levelPercent: normalizeOptionalNumber(device?.levelPercent),
        levelStatusLabel: optionalText(device?.levelStatusLabel),
        currentStatusLabel: optionalText(device?.currentStatusLabel),
        alertState: optionalText(device?.alertState),
        feederMode: optionalText(device?.feederMode),
        feederConstantGrams: normalizeOptionalNumber(device?.feederConstantGrams),
        feederLastPortionGrams: normalizeOptionalNumber(device?.feederLastPortionGrams),
        nextFeedingLabel: optionalText(device?.nextFeedingLabel),
        waterCirculationActive:
          typeof device?.waterCirculationActive === "boolean"
            ? device.waterCirculationActive
            : null,
        waterLastChangeLabel: optionalText(device?.waterLastChangeLabel),
        waterLastRefillLabel: optionalText(device?.waterLastRefillLabel),
        litterMode: optionalText(device?.litterMode),
        litterDelayMinutes: normalizeOptionalNumber(device?.litterDelayMinutes),
        litterLastCleaningLabel: optionalText(device?.litterLastCleaningLabel),
        litterLastUsageLabel: optionalText(device?.litterLastUsageLabel),
        schedules: normalizeDeviceSchedules(device?.schedules),
        recentHistory: normalizeDeviceHistory(device?.recentHistory)
      };
    })
    .filter(Boolean);
}

async function enrichDevicesWithRealtimeState(devices) {
  if (!Array.isArray(devices) || !devices.length || !realtimeDbBaseUrl) {
    return devices;
  }

  const typeCounts = devices.reduce((counts, device) => {
    counts[device.type] = (counts[device.type] || 0) + 1;
    return counts;
  }, {});

  const [feederState, waterState, litterState] = await Promise.all([
    typeCounts.Feeder === 1 ? fetchRealtimeNode("comedero") : Promise.resolve(null),
    typeCounts.WaterFountain === 1 ? fetchRealtimeNode("bebedero") : Promise.resolve(null),
    typeCounts.LitterBox === 1 ? fetchRealtimeNode("arenero") : Promise.resolve(null)
  ]);

  return devices.map((device) => {
    switch (device.type) {
      case "Feeder":
        return mergeRealtimeFeederState(device, feederState);
      case "WaterFountain":
        return mergeRealtimeWaterState(device, waterState);
      case "LitterBox":
        return mergeRealtimeLitterState(device, litterState);
      default:
        return device;
    }
  });
}

async function fetchRealtimeNode(nodeName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);

  try {
    const response = await fetch(
      `${realtimeDbBaseUrl.replace(/\/$/, "")}/dispositivos/${nodeName}.json`,
      { signal: controller.signal }
    );
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (!payload || typeof payload !== "object") {
      return null;
    }

    return payload;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function mergeRealtimeFeederState(device, payload) {
  if (!payload || typeof payload !== "object") return device;

  const effectiveOnline = resolveRealtimeOnline(
    payload.online,
    payload.updated_at_ms
  );
  const levelPercent = normalizeOptionalNumber(payload.nivel_comida);

  return {
    ...device,
    wifiSsid: optionalText(payload.wifi_ssid) || device.wifiSsid,
    ipAddress: effectiveOnline
      ? optionalText(payload.ip) || device.ipAddress
      : device.ipAddress,
    isOnline: effectiveOnline,
    levelPercent: levelPercent !== null ? clampPercent(levelPercent) : device.levelPercent,
    levelStatusLabel:
      levelPercent !== null ? buildLevelStatusLabel(clampPercent(levelPercent)) : device.levelStatusLabel,
    alertState:
      levelPercent !== null ? buildAlertStateLabel(clampPercent(levelPercent)) : device.alertState
  };
}

function mergeRealtimeWaterState(device, payload) {
  if (!payload || typeof payload !== "object") return device;

  const effectiveOnline = resolveRealtimeOnline(
    payload.online,
    payload.updated_at_ms
  );
  const levelPercent = normalizeOptionalNumber(payload.nivel_agua);
  const circulationActive =
    typeof payload.circulacion_activa === "boolean"
      ? payload.circulacion_activa
      : device.waterCirculationActive;

  return {
    ...device,
    wifiSsid: optionalText(payload.wifi_ssid) || device.wifiSsid,
    ipAddress: effectiveOnline
      ? optionalText(payload.ip) || device.ipAddress
      : device.ipAddress,
    isOnline: effectiveOnline,
    levelPercent: levelPercent !== null ? clampPercent(levelPercent) : device.levelPercent,
    levelStatusLabel:
      levelPercent !== null ? buildLevelStatusLabel(clampPercent(levelPercent)) : device.levelStatusLabel,
    currentStatusLabel:
      typeof circulationActive === "boolean"
        ? circulationActive
          ? "Circulacion activa"
          : "Circulacion inactiva"
        : device.currentStatusLabel,
    alertState:
      levelPercent !== null ? buildAlertStateLabel(clampPercent(levelPercent)) : device.alertState,
    waterCirculationActive: circulationActive
  };
}

function mergeRealtimeLitterState(device, payload) {
  if (!payload || typeof payload !== "object") return device;

  const effectiveOnline = resolveRealtimeOnline(
    payload.online,
    payload.updated_at_ms
  );
  const levelPercent = normalizeOptionalNumber(payload.nivel_arena);
  const catDetected =
    typeof payload.deteccion_gato === "boolean"
      ? payload.deteccion_gato
      : null;

  return {
    ...device,
    wifiSsid: optionalText(payload.wifi_ssid) || device.wifiSsid,
    ipAddress: effectiveOnline
      ? optionalText(payload.ip) || device.ipAddress
      : device.ipAddress,
    isOnline: effectiveOnline,
    levelPercent: levelPercent !== null ? clampPercent(levelPercent) : device.levelPercent,
    levelStatusLabel:
      levelPercent !== null ? buildLevelStatusLabel(clampPercent(levelPercent)) : device.levelStatusLabel,
    currentStatusLabel:
      typeof catDetected === "boolean"
        ? catDetected
          ? "En uso"
          : "Libre"
        : device.currentStatusLabel,
    alertState:
      levelPercent !== null ? buildAlertStateLabel(clampPercent(levelPercent)) : device.alertState
  };
}

function resolveRealtimeOnline(remoteOnline, updatedAtMillis) {
  if (!remoteOnline) return false;

  const updatedAt = normalizeOptionalNumber(updatedAtMillis);
  if (updatedAt === null) return Boolean(remoteOnline);

  return Date.now() - updatedAt <= 8_000;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function buildLevelStatusLabel(levelPercent) {
  if (levelPercent <= 10) return "Critico";
  if (levelPercent <= 30) return "Bajo";
  return "Optimo";
}

function buildAlertStateLabel(levelPercent) {
  if (levelPercent <= 10) return "Critico";
  if (levelPercent <= 30) return "Bajo";
  return null;
}

function normalizeDeviceSchedules(schedules) {
  if (!Array.isArray(schedules)) return [];

  return schedules
    .map((schedule) => {
      const label = optionalText(schedule?.label);
      if (!label) return null;

      return {
        label,
        detail: optionalText(schedule?.detail),
        enabled:
          typeof schedule?.enabled === "boolean"
            ? schedule.enabled
            : null
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeDeviceHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .map((entry) => {
      const title = optionalText(entry?.title);
      const value = optionalText(entry?.value);
      if (!title || !value) return null;

      return {
        title,
        value,
        createdAtLabel: optionalText(entry?.createdAtLabel)
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function normalizeUserProfile(profile) {
  const fullName = optionalText(profile?.fullName);
  if (!fullName) return null;

  return {
    fullName,
    location: optionalText(profile?.location),
    memberSince: optionalText(profile?.memberSince),
    planName: optionalText(profile?.planName)
  };
}

function normalizeAppStats(stats) {
  if (!stats || typeof stats !== "object") return null;

  return {
    totalPets: normalizeOptionalNumber(stats?.totalPets) ?? 0,
    totalDevices: normalizeOptionalNumber(stats?.totalDevices) ?? 0,
    totalRoutines: normalizeOptionalNumber(stats?.totalRoutines) ?? 0,
    unreadNotifications: normalizeOptionalNumber(stats?.unreadNotifications) ?? 0,
    onlineDevices: normalizeOptionalNumber(stats?.onlineDevices) ?? 0,
    offlineDevices: normalizeOptionalNumber(stats?.offlineDevices) ?? 0,
    lowLevelDevices: normalizeOptionalNumber(stats?.lowLevelDevices) ?? 0,
    criticalLevelDevices: normalizeOptionalNumber(stats?.criticalLevelDevices) ?? 0,
    feederDevices: normalizeOptionalNumber(stats?.feederDevices) ?? 0,
    waterFountainDevices: normalizeOptionalNumber(stats?.waterFountainDevices) ?? 0,
    litterBoxDevices: normalizeOptionalNumber(stats?.litterBoxDevices) ?? 0
  };
}

function normalizeNotificationSettings(settings) {
  if (!settings || typeof settings !== "object") return null;

  return {
    allNotificationsEnabled: Boolean(settings?.allNotificationsEnabled),
    soundEnabled: Boolean(settings?.soundEnabled),
    feederMealServedEnabled: Boolean(settings?.feederMealServedEnabled),
    feederLowFoodEnabled: Boolean(settings?.feederLowFoodEnabled),
    feederFoodEmptyEnabled: Boolean(settings?.feederFoodEmptyEnabled),
    waterFreshEnabled: Boolean(settings?.waterFreshEnabled),
    waterLowEnabled: Boolean(settings?.waterLowEnabled),
    waterEmptyEnabled: Boolean(settings?.waterEmptyEnabled),
    litterCatDetectedEnabled: Boolean(settings?.litterCatDetectedEnabled),
    litterCleaningCompleteEnabled: Boolean(settings?.litterCleaningCompleteEnabled),
    litterLowLevelEnabled: Boolean(settings?.litterLowLevelEnabled),
    litterReminderEnabled: Boolean(settings?.litterReminderEnabled)
  };
}

function normalizeRecentNotifications(notifications) {
  if (!Array.isArray(notifications)) return [];

  return notifications
    .map((notification) => {
      const title = optionalText(notification?.title);
      const body = optionalText(notification?.body);
      if (!title || !body) return null;

      return {
        title,
        body,
        deviceType: optionalText(notification?.deviceType),
        isRead: Boolean(notification?.isRead),
        createdAtLabel: optionalText(notification?.createdAtLabel)
      };
    })
    .filter(Boolean)
    .slice(0, 10);
}

function buildInstructions({
  currentMessage,
  pets,
  routines,
  devices,
  userProfile,
  appStats,
  notificationSettings,
  recentNotifications,
  selectedPetId,
  selectedPetName,
  selectedPetImage
}) {
  const intent = analyzeMessageIntent(currentMessage);
  const selectedPet = resolveSelectedPet({
    pets,
    selectedPetId,
    selectedPetName,
    currentMessage
  });
  const selectedDevice = resolveSelectedDevice({
    devices,
    currentMessage
  });
  const ambiguityNote = buildAmbiguityNote({
    pets,
    selectedPet,
    currentMessage
  });
  const deviceAmbiguityNote = buildDeviceAmbiguityNote({
    devices,
    selectedDevice,
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
  const devicesBlock = buildRelevantDevicesBlock({
    devices,
    selectedDevice,
    intent
  });
  const appCapabilitiesBlock = buildAppCapabilitiesBlock({
    appStats,
    devices,
    intent
  });
  const statsBlock = buildStatsBlock({
    appStats,
    intent
  });
  const userProfileBlock = buildUserProfileBlock({
    userProfile,
    intent
  });
  const notificationSettingsBlock = buildNotificationSettingsBlock({
    notificationSettings,
    intent
  });
  const recentNotificationsBlock = buildRecentNotificationsBlock({
    recentNotifications,
    intent
  });
  const contextAvailabilityBlock = buildContextAvailabilityBlock({
    pets,
    routines,
    devices,
    userProfile,
    recentNotifications,
    intent
  });

  const focusBlock = selectedPet
    ? `Mascota principal para este turno: ${selectedPet.name}.`
    : null;
  const selectedPetResolvedBlock = buildSelectedPetResolvedBlock({
    selectedPet,
    intent,
    selectedPetImage
  });
  const selectedPetImageBlock = buildSelectedPetImageBlock({
    selectedPet,
    selectedPetImage,
    intent
  });
  const routineActionBlock = buildRoutineActionBlock({
    pets,
    selectedPet,
    intent
  });
  const petDescriptionActionBlock = buildPetDescriptionActionBlock({
    selectedPet,
    intent
  });
  const deviceActionBlock = buildDeviceActionBlock({
    selectedDevice,
    intent
  });
  const focusDeviceBlock = selectedDevice
    ? `Dispositivo principal para este turno: ${selectedDevice.customName}.`
    : null;

  return [
    systemPrompt,
    "",
    "Contexto real para este turno:",
    contextAvailabilityBlock,
    appCapabilitiesBlock,
    focusBlock,
    selectedPetResolvedBlock,
    selectedPetImageBlock,
    routineActionBlock,
    petDescriptionActionBlock,
    deviceActionBlock,
    focusDeviceBlock,
    ambiguityNote,
    deviceAmbiguityNote,
    statsBlock,
    userProfileBlock,
    petsBlock,
    routinesBlock,
    devicesBlock,
    notificationSettingsBlock,
    recentNotificationsBlock,
    "Lo que aparece aqui ya esta guardado en la app.",
    "Si arriba aparecen mascotas, rutinas, dispositivos, perfil o notificaciones, no respondas que no puedes ver la informacion de la app.",
    intent.wantsSummary || intent.wantsCapabilities || intent.wantsAccount
      ? "Si el usuario pregunta que informacion de la app conoces o puedes revisar, responde con un resumen corto de lo que si esta disponible en este turno."
      : null,
    "Usa este contexto como memoria silenciosa y no como texto para repetir.",
    "No cites etiquetas, campos, nombres, rutinas, horarios, porcentajes, estados ni redes WiFi salvo que el usuario lo pida de forma explicita.",
    "No pidas confirmar datos que ya aparecen aqui.",
    intent.wantsRoutine
      ? "El usuario si esta preguntando por rutinas, asi que puedes usarlas si ayudan."
      : "No menciones rutinas en la respuesta salvo que el usuario las pida.",
    intent.wantsDeviceStatus || intent.wantsStats || intent.wantsNotifications || intent.wantsCapabilities
      ? "El usuario si esta preguntando por dispositivos, estados, stats o notificaciones, asi que puedes usar ese contexto si ayuda."
      : "No menciones dispositivos, niveles, notificaciones ni estados salvo que el usuario lo pida.",
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

function buildSelectedPetResolvedBlock({ selectedPet, intent, selectedPetImage }) {
  if (!selectedPet) return null;

  const petType = optionalText(selectedPet.typeLabel) || optionalText(selectedPet.type) || optionalText(selectedPet.customType);
  const inferredLifeStage = inferPetLifeStage(selectedPet);
  const lines = [
    `La mascota mencionada en este turno ya esta resuelta: ${selectedPet.name}.`,
    petType ? `Tipo confirmado de esa mascota: ${petType}.` : null,
    optionalText(selectedPet.ageLabel) ? `Edad disponible de esa mascota: ${selectedPet.ageLabel}.` : null,
    optionalText(selectedPet.weightLabel) ? `Peso disponible de esa mascota: ${selectedPet.weightLabel}.` : null,
    inferredLifeStage ? `Etapa de vida inferida de esa mascota: ${inferredLifeStage}.` : null,
    selectedPetImage ? "Hay una foto real adjunta de esta mascota en este turno." : null,
    "Usa esta mascota como referencia principal en toda la respuesta.",
    "No vuelvas a preguntar si es perro o gato si ese dato ya aparece aqui.",
    "Antes de preguntar algo sobre esta mascota, revisa si el dato ya aparece arriba o si puede inferirse con lo que ya esta guardado.",
    "Si ya tienes edad y tipo de mascota, no vuelvas a preguntar si es cachorro, gatito, adulto o senior.",
    "No vuelvas a pedir nombre, especie o tipo de esta mascota salvo que exista un conflicto real entre varios registros."
  ];

  return lines.filter(Boolean).join("\n");
}

function buildSelectedPetImageBlock({ selectedPet, selectedPetImage, intent }) {
  if (!selectedPetImage || !intent.wantsVisualAnalysis) return null;

  const petName = selectedPetImage.petName || selectedPet?.name || "la mascota relevante";
  return [
    `Imagen real adjunta para este turno: corresponde a ${petName}.`,
    "Puedes usar la imagen para analizar rasgos visibles si ayudan a responder.",
    "Si te piden la raza a partir de la foto, responde primero con la raza aparente o el tipo visible mas probable y luego aclara que es una estimacion prudente, no una certeza absoluta.",
    "Si la foto no permite identificar bien la raza, dilo con honestidad y sugiere que probablemente sea mestizo o mezcla cuando aplique.",
    "No ignores rasgos visuales claros como largo del pelaje, patron del manto, forma general de la cara o coloraciones evidentes.",
    "No digas que no puedes ver la foto si esta imagen fue adjunta en este turno."
  ].join("\n");
}

function resolveSelectedDevice({ devices, currentMessage }) {
  if (!Array.isArray(devices) || !devices.length) return null;

  const normalizedMessage = normalizeName(currentMessage);

  const byName = devices.filter((device) =>
    normalizedMessage.includes(normalizeName(device.customName))
  );
  if (byName.length === 1) return byName[0];

  const typeMatches = devices.filter((device) => {
    const normalizedType = normalizeName(device.typeLabel);
    return normalizedType && normalizedMessage.includes(normalizedType);
  });
  if (typeMatches.length === 1) return typeMatches[0];

  return devices.length === 1 ? devices[0] : null;
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
      ),
    wantsDeviceStatus:
      /\b(dispositivo|dispositivos|comedero|bebedero|arenero|wifi|bluetooth|nivel|porcentaje|estado|en linea|sin conexion|circulacion|limpieza|recarga|servida|servido|agua|arena)\b/.test(
        normalized
      ),
    wantsNotifications:
      /\b(notificacion|notificaciones|campana|alerta|alertas|aviso|avisos|recordatorio|recordatorios)\b/.test(
        normalized
      ),
    wantsAccount:
      /\b(perfil|cuenta|plan|nombre|ubicacion|miembro desde|informacion personal)\b/.test(
        normalized
      ),
    wantsStats:
      /\b(estadistica|estadisticas|resumen|porcentaje|porcentajes|nivel|niveles|estado general|panel|dashboard)\b/.test(
        normalized
      ),
    wantsCapabilities:
      /\b(camara|camaras|camara de seguridad|vision|video|videos|grabar|graba|vigilar|vigilancia|funcion|funciones|que hace la app|que puede hacer|que hace domoticpet|que puede hacer domoticpet|compatibilidad|compatible|modulo|modulos|que informacion|que datos|puedes ver la app|informacion de la app|datos de la app)\b/.test(
        normalized
      ),
    wantsVisualAnalysis:
      /\b(raza|breed|foto|fotos|imagen|imagenes|revisa la foto|revisar la foto|mira la foto|mirar la foto|ves en la foto|que ves|como se ve|pelaje|color|parece)\b/.test(
        normalized
      ),
    wantsCreateRoutineAction:
      /\b(crea|crear|agrega|agregar|programa|programar|haz|hacer)\b/.test(normalized) &&
      /\b(rutina|recordatorio|alarma)\b/.test(normalized),
    wantsSavePetInfoAction:
      /\b(guarda|guardar|agrega|agregar|anade|añade|actualiza|actualizar|anota|deja|recuerda|registra)\b/.test(normalized) &&
      /\b(descripcion|descripción|perfil|info|informacion|información|nota|notas|dato|datos|alergia|alergias|medicamento|medicamentos|condicion|condición|comportamiento|personalidad|comida|alimento|peso)\b/.test(normalized),
    wantsRenameDeviceAction:
      /\b(cambia|cambiar|renombra|renombrar|ponle|ponerle)\b/.test(normalized) &&
      /\b(nombre)\b/.test(normalized) &&
      /\b(dispositivo|comedero|bebedero|arenero)\b/.test(normalized),
    wantsWaterCirculationAction:
      /\b(circulacion|circulación)\b/.test(normalized) &&
      /\b(activa|activar|enciende|encender|desactiva|desactivar|apaga|apagar)\b/.test(normalized)
  };
}

function buildRoutineActionBlock({ pets, selectedPet, intent }) {
  if (!intent.wantsCreateRoutineAction) return null;

  const petGuidance = selectedPet
    ? `Mascota objetivo ya resuelta para la accion: ${selectedPet.name}.`
    : pets.length
      ? `Mascotas disponibles para usar en la accion: ${pets.map((pet) => pet.name).join(", ")}.`
      : "No hay mascotas registradas; si hace falta, la rutina puede ser general.";

  return [
    "Si el usuario esta pidiendo crear, agregar o programar una rutina y ya tienes datos suficientes, agrega al final de tu respuesta un bloque oculto de accion.",
    "Primero responde en lenguaje natural. Despues, en una linea aparte, agrega exactamente este formato sin explicarlo:",
    '<domoticpet_action>{"id":"routine_x","type":"create_routine","executed":false,"routine":{"name":"Nombre","petId":1,"petName":"Mimi","category":"Food","priority":"High","time":"19:00","frequencyType":"Daily","specificDays":[],"intervalDays":1,"notes":"", "startDate":"2026-03-19","endDate":null,"notificationsEnabled":true,"alarmEnabled":false,"vibrationEnabled":true,"colorHex":"#12B6D8","repeatIndefinitely":true,"isImportant":false}}</domoticpet_action>',
    "Usa solo estos valores para category: Food, Medication, Walk, Hygiene, Play, Vet, Other.",
    "Usa solo estos valores para priority: High, Medium, Low. Si no aplica, omite el valor o dejalo null.",
    "Usa solo estos valores para frequencyType: Once, Daily, SpecificDays, EveryXDays, Weekly, Monthly.",
    "time debe ir en formato 24 horas HH:mm.",
    "specificDays debe usar nombres en ingles como MONDAY, TUESDAY, WEDNESDAY, THURSDAY, FRIDAY, SATURDAY, SUNDAY solo si hace falta.",
    "Si falta un dato critico para crear la rutina bien, no generes el bloque. Haz solo una pregunta corta.",
    "Si emites este bloque, ya puedes redactar la respuesta como una rutina agregada en la app.",
    petGuidance
  ].join("\n");
}

function buildPetDescriptionActionBlock({ selectedPet, intent }) {
  if (!intent.wantsSavePetInfoAction || !selectedPet) return null;

  return [
    "Si el usuario quiere guardar una informacion importante dentro de la mascota y ya sabes a cual mascota se refiere, puedes emitir una accion para agregarla a su descripcion.",
    "Primero responde normal y luego agrega exactamente este formato en una linea aparte:",
    `<domoticpet_action>{"id":"pet_note_x","type":"update_pet_description","executed":false,"petDescription":{"petId":${selectedPet.id ?? "null"},"petName":"${selectedPet.name}","appendText":"Texto breve para guardar en la descripcion"}}</domoticpet_action>`,
    "appendText debe ser breve, claro y util para recordar despues.",
    "Solo genera esta accion si el usuario claramente quiere que esa informacion quede guardada en la app.",
    "Si emites esta accion, ya puedes redactar la respuesta como un cambio aplicado en la app."
  ].join("\n");
}

function buildDeviceActionBlock({ selectedDevice, intent }) {
  if (!selectedDevice) return null;

  const blocks = [];

  if (intent.wantsRenameDeviceAction) {
    blocks.push([
      "Si el usuario quiere cambiar el nombre de un dispositivo y el dispositivo ya esta resuelto, puedes emitir esta accion:",
      `<domoticpet_action>{"id":"device_rename_x","type":"rename_device","executed":false,"renameDevice":{"deviceId":${selectedDevice.id},"deviceName":"${selectedDevice.customName}","newName":"Nuevo nombre"}}</domoticpet_action>`,
      "Si emites esta accion, ya puedes redactar la respuesta como un cambio aplicado en la app."
    ].join("\n"));
  }

  if (intent.wantsWaterCirculationAction && selectedDevice.type === "WaterFountain") {
    blocks.push([
      "Si el usuario quiere activar o desactivar la circulacion del bebedero, puedes emitir esta accion:",
      `<domoticpet_action>{"id":"water_circulation_x","type":"set_water_circulation","executed":false,"waterCirculation":{"deviceId":${selectedDevice.id},"deviceName":"${selectedDevice.customName}","enabled":true}}</domoticpet_action>`,
      "Usa enabled=true para activar y enabled=false para desactivar.",
      "Si emites esta accion, ya puedes redactar la respuesta como un cambio aplicado en la app."
    ].join("\n"));
  }

  return blocks.length ? blocks.join("\n\n") : null;
}

function buildContextAvailabilityBlock({
  pets,
  routines,
  devices,
  userProfile,
  recentNotifications,
  intent
}) {
  if (!pets.length && !routines.length && !devices.length && !userProfile && !recentNotifications.length) {
    return "No hay datos adicionales de la app disponibles en este turno.";
  }

  const lines = [
    "Resumen interno del contexto disponible:",
    `- Mascotas disponibles: ${pets.length}`,
    `- Rutinas disponibles: ${routines.length}`,
    `- Dispositivos disponibles: ${devices.length}`,
    `- Perfil disponible: ${userProfile ? "Si" : "No"}`,
    `- Notificaciones recientes disponibles: ${recentNotifications.length}`
  ];

  if (intent.wantsSummary || intent.wantsCapabilities || intent.wantsAccount) {
    lines.push("Si el usuario pregunta por la informacion de la app, responde usando este contexto y no digas que no puedes verlo.");
  }

  return lines.join("\n");
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

  if (pets.length <= 3) {
    return [
      "Mascotas registradas para referencia interna:",
      pets.slice(0, 3).map((pet) => formatPetOverview(pet)).join("\n")
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

function buildRelevantDevicesBlock({ devices, selectedDevice, intent }) {
  if (intent.isGreetingOnly) {
    return null;
  }

  if (!devices.length) {
    return "No hay dispositivos DomoticPet conectados en la app.";
  }

  if (selectedDevice) {
    return [
      "Dispositivo relevante para responder:",
      formatDeviceContext(selectedDevice)
    ].join("\n");
  }

  if (
    intent.wantsDeviceStatus ||
    intent.wantsStats ||
    intent.wantsNotifications ||
    intent.wantsCapabilities ||
    intent.wantsSummary ||
    devices.length <= 3
  ) {
    return [
      "Inventario interno de dispositivos:",
      devices.slice(0, 6).map((device) => formatDeviceInventoryLine(device)).join("\n")
    ].join("\n");
  }

  return `Hay ${devices.length} dispositivo(s) DomoticPet registrados para referencia interna. No muestres la lista completa salvo que el usuario la pida.`;
}

function buildAppCapabilitiesBlock({ appStats, devices, intent }) {
  if (intent.isGreetingOnly) return null;

  const configuredTypes = Array.from(
    new Set(
      devices
        .map((device) => optionalText(device.typeLabel))
        .filter(Boolean)
    )
  );

  return [
    "Capacidades reales de DomoticPet:",
    "- Modulos actuales: mascotas, rutinas, perfil, notificaciones, chat IA y dispositivos DomoticPet.",
    "- Dispositivos compatibles de la app: comedero, bebedero y arenero.",
    "- No hay camaras, video ni vigilancia.",
    appStats ? `- Dispositivos registrados ahora: ${appStats.totalDevices}.` : null,
    configuredTypes.length
      ? `- Tipos de dispositivos presentes en esta cuenta: ${configuredTypes.join(", ")}.`
      : "- Aun no hay dispositivos registrados en esta cuenta.",
    "- Los estados de dispositivos corresponden al ultimo estado sincronizado por la app."
  ]
    .filter(Boolean)
    .join("\n");
}

function buildStatsBlock({ appStats, intent }) {
  if (!appStats || intent.isGreetingOnly) return null;

  return [
    "Resumen interno de la app:",
    `- Mascotas: ${appStats.totalPets}`,
    `- Dispositivos: ${appStats.totalDevices}`,
    `- Comederos: ${appStats.feederDevices}`,
    `- Bebederos: ${appStats.waterFountainDevices}`,
    `- Areneros: ${appStats.litterBoxDevices}`,
    `- Rutinas: ${appStats.totalRoutines}`,
    `- Notificaciones sin leer: ${appStats.unreadNotifications}`,
    `- Dispositivos en linea: ${appStats.onlineDevices}`,
    `- Dispositivos sin conexion: ${appStats.offlineDevices}`,
    `- Dispositivos en bajo nivel: ${appStats.lowLevelDevices}`,
    `- Dispositivos en nivel critico: ${appStats.criticalLevelDevices}`
  ].join("\n");
}

function buildUserProfileBlock({ userProfile, intent }) {
  if (!userProfile || (!intent.wantsAccount && !intent.wantsSummary)) {
    return null;
  }

  const lines = ["Perfil real de la cuenta:"];
  addLine(lines, "Nombre", userProfile.fullName);
  addLine(lines, "Ubicacion", userProfile.location);
  addLine(lines, "Plan", userProfile.planName);
  addLine(lines, "Miembro desde", userProfile.memberSince);
  return lines.join("\n");
}

function buildNotificationSettingsBlock({ notificationSettings, intent }) {
  if (!notificationSettings || !intent.wantsNotifications) {
    return null;
  }

  return [
    "Configuracion actual de notificaciones:",
    `- Todas activas: ${notificationSettings.allNotificationsEnabled ? "Si" : "No"}`,
    `- Sonido: ${notificationSettings.soundEnabled ? "Si" : "No"}`,
    `- Comedero: comida servida=${boolLabel(notificationSettings.feederMealServedEnabled)}, nivel bajo=${boolLabel(notificationSettings.feederLowFoodEnabled)}, comida agotada=${boolLabel(notificationSettings.feederFoodEmptyEnabled)}`,
    `- Bebedero: cambio de agua=${boolLabel(notificationSettings.waterFreshEnabled)}, nivel bajo=${boolLabel(notificationSettings.waterLowEnabled)}, agua agotada=${boolLabel(notificationSettings.waterEmptyEnabled)}`,
    `- Arenero: gato detectado=${boolLabel(notificationSettings.litterCatDetectedEnabled)}, limpieza completada=${boolLabel(notificationSettings.litterCleaningCompleteEnabled)}, nivel bajo=${boolLabel(notificationSettings.litterLowLevelEnabled)}, recordatorio=${boolLabel(notificationSettings.litterReminderEnabled)}`
  ].join("\n");
}

function buildRecentNotificationsBlock({ recentNotifications, intent }) {
  if (!recentNotifications.length || !intent.wantsNotifications) {
    return null;
  }

  return [
    "Notificaciones recientes:",
    recentNotifications
      .slice(0, 8)
      .map((notification, index) => formatNotificationContext(notification, index + 1))
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

function buildDeviceAmbiguityNote({ devices, selectedDevice, currentMessage }) {
  if (selectedDevice || !devices.length) return null;

  const normalizedMessage = normalizeName(currentMessage);
  const mentionedTypes = devices
    .filter((device) => normalizedMessage.includes(normalizeName(device.typeLabel)))
    .map((device) => device.typeLabel);

  if (!mentionedTypes.length) return null;

  const duplicatedTypes = findDuplicatedDeviceTypes(devices).filter((typeLabel) =>
    mentionedTypes.some((mentioned) => normalizeName(mentioned) === normalizeName(typeLabel))
  );

  if (!duplicatedTypes.length) return null;

  return `Atencion: hay varios dispositivos de tipo ${duplicatedTypes.join(", ")}. Si hace falta, pide una aclaracion corta por nombre.`;
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

function findDuplicatedDeviceTypes(devices) {
  const counts = new Map();

  for (const device of devices) {
    const normalized = normalizeName(device.typeLabel);
    counts.set(normalized, (counts.get(normalized) || 0) + 1);
  }

  return devices
    .map((device) => device.typeLabel)
    .filter((typeLabel, index, labels) => {
      const normalized = normalizeName(typeLabel);
      return counts.get(normalized) > 1 && labels.indexOf(typeLabel) === index;
    });
}

function formatPetContext(pet, intent) {
  const lines = [`Nombre: ${pet.name}`];

  addLine(lines, "Tipo", pet.typeLabel || pet.type || pet.customType);
  addLine(lines, "Foto registrada", pet.hasPhoto ? "Si" : "No");
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

function formatDeviceContext(device) {
  const lines = [`Nombre: ${device.customName}`];

  addLine(lines, "Tipo", device.typeLabel);
  addLine(lines, "Estado de conexion", device.isOnline ? "En linea" : "Sin conexion");
  addLine(lines, "Red WiFi", device.wifiSsid);
  addLine(lines, "IP", device.ipAddress);
  addLine(lines, "Nivel", buildLevelFallback(device));
  addLine(lines, "Estado actual", device.currentStatusLabel);
  addLine(lines, "Estado de nivel", device.levelStatusLabel);
  addLine(lines, "Alerta", device.alertState);
  addLine(lines, "Modo del comedero", device.feederMode);
  addLine(lines, "Peso constante", device.feederConstantGrams ? `${device.feederConstantGrams} g` : null);
  addLine(lines, "Ultima porcion", device.feederLastPortionGrams ? `${device.feederLastPortionGrams} g` : null);
  addLine(lines, "Proxima alimentacion", device.nextFeedingLabel);
  if (typeof device.waterCirculationActive === "boolean") {
    addLine(lines, "Circulacion", device.waterCirculationActive ? "Activa" : "Inactiva");
  }
  addLine(lines, "Ultimo cambio de agua", device.waterLastChangeLabel);
  addLine(lines, "Ultima recarga", device.waterLastRefillLabel);
  addLine(lines, "Modo del arenero", device.litterMode);
  addLine(lines, "Retraso despues del uso", device.litterDelayMinutes ? `${device.litterDelayMinutes} min` : null);
  addLine(lines, "Ultima limpieza", device.litterLastCleaningLabel);
  addLine(lines, "Ultimo uso", device.litterLastUsageLabel);

  if (Array.isArray(device.schedules) && device.schedules.length) {
    lines.push("Horarios relevantes:");
    device.schedules.forEach((schedule) => {
      const detail = [schedule.label, schedule.detail].filter(Boolean).join(" - ");
      lines.push(`- ${detail}`);
    });
  }

  if (Array.isArray(device.recentHistory) && device.recentHistory.length) {
    lines.push("Historial reciente:");
    device.recentHistory.forEach((entry) => {
      const detail = [entry.createdAtLabel, entry.title, entry.value].filter(Boolean).join(" - ");
      lines.push(`- ${detail}`);
    });
  }

  return lines.join("\n");
}

function formatDeviceInventoryLine(device) {
  const parts = [
    device.customName,
    device.typeLabel,
    device.isOnline ? "en linea" : "sin conexion",
    typeof device.levelPercent === "number" ? `${device.levelPercent}%` : null
  ].filter(Boolean);

  return `- ${parts.join(" - ")}`;
}

function formatNotificationContext(notification, index) {
  const parts = [
    `${index}. ${notification.title}`,
    notification.deviceType,
    notification.createdAtLabel,
    notification.isRead ? "leida" : "sin leer"
  ].filter(Boolean);

  return `- ${parts.join(" - ")} - ${notification.body}`;
}

function buildAgeFallback(pet) {
  if (!pet.ageValue) return "";
  return pet.ageUnit ? `${pet.ageValue} ${pet.ageUnit}` : pet.ageValue;
}

function buildWeightFallback(pet) {
  return pet.weightKg ? `${pet.weightKg} kg` : "";
}

function buildLevelFallback(device) {
  return typeof device.levelPercent === "number" ? `${device.levelPercent}%` : "";
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

function boolLabel(value) {
  return value ? "Si" : "No";
}

function buildFoodInstruction(selectedPet) {
  if (!selectedPet) {
    return "Si faltan datos del alimento para responder bien, pide solo la marca y, si hace falta, la linea o descripcion general del producto.";
  }

  const inferredLifeStage = inferPetLifeStage(selectedPet);
  const instructions = [];

  if (inferredLifeStage) {
    instructions.push([
      `Ya puedes inferir la etapa de vida de ${selectedPet.name} como ${inferredLifeStage}.`,
      "No vuelvas a preguntar si es cachorro, gatito, adulto o senior si eso ya se puede deducir.",
      "Solo pide una aclaracion adicional si falta algo realmente critico para distinguir una recomendacion."
    ].join(" "));
  }

  if (Array.isArray(selectedPet.foodCatalogMatches) && selectedPet.foodCatalogMatches.length === 1) {
    const match = selectedPet.foodCatalogMatches[0];
    if (match.kcalPerKg || match.kcalPerCup) {
      instructions.push("Hay una coincidencia clara en el catalogo local y trae energia verificada. Puedes usarla como apoyo interno para orientar una porcion de forma simple, sin mostrar formulas ni tecnicismos.");
      return instructions.join(" ");
    }
  }

  if (Array.isArray(selectedPet.foodCatalogMatches) && selectedPet.foodCatalogMatches.length > 1) {
    instructions.push("Hay varias coincidencias posibles en el catalogo local. No adivines cual es, pero si el usuario pide una porcion puedes dar primero una guia aproximada basada en peso, especie y etapa de vida. Solo despues pide una aclaracion corta sobre la linea o el nombre exacto del producto si quiere mas precision.");
    return instructions.join(" ");
  }

  if (selectedPet.foodBrands && !selectedPet.foodDescription) {
    instructions.push("Solo hay una marca general del alimento y no alcanza para identificar bien el producto o la linea. No inventes calorias exactas, pero si ya tienes peso, especie o etapa de vida da primero una guia diaria aproximada en gramos. Despues ofrece afinarla si el usuario comparte la linea o presentacion exacta.");
    return instructions.join(" ");
  }

  if (selectedPet.weightKg || inferredLifeStage) {
    instructions.push("Si no tienes el producto exacto pero si peso, especie o etapa de vida, responde primero con una estimacion util y prudente en gramos o rango diario. No obligues al usuario a darte calorias exactas para poder orientarlo.");
    return instructions.join(" ");
  }

  instructions.push("Si faltan datos para responder bien sobre comida, pide solo el dato faltante mas importante en una pregunta corta y sin formulas tecnicas.");
  return instructions.join(" ");
}

function inferPetLifeStage(pet) {
  const ageValue = normalizeOptionalNumber(pet?.ageValue);
  const ageUnit = normalizeName(pet?.ageUnit || "");
  const petType = normalizeName(pet?.typeLabel || pet?.type || pet?.customType || "");
  const sex = normalizeName(pet?.sex || "");

  if (ageValue === null || !ageUnit) return null;

  const ageInMonths = ageUnit.includes("ano") || ageUnit.includes("year")
    ? ageValue * 12
    : ageUnit.includes("mes") || ageUnit.includes("month")
      ? ageValue
      : null;

  if (ageInMonths === null) return null;

  if (petType.includes("gato") || petType.includes("cat")) {
    if (ageInMonths < 12) return sex.includes("macho") ? "gatito" : "gatita";
    if (ageInMonths >= 84) return "senior";
    return sex.includes("macho") ? "adulto" : "adulta";
  }

  if (petType.includes("perro") || petType.includes("dog")) {
    if (ageInMonths < 12) return "cachorro";
    if (ageInMonths >= 84) return "senior";
    return sex.includes("hembra") ? "adulta" : "adulto";
  }

  if (ageInMonths < 12) return "joven";
  if (ageInMonths >= 84) return "senior";
  return "adulta";
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

function sendHttpError(res, error, route = "/chat") {
  const status = getClientSafeStatus(error);
  logServerError(error, route);
  res.status(status).json({
    error: "chat_failed",
    message: getClientSafeErrorMessage(error)
  });
}

function getClientSafeStatus(error) {
  if (error instanceof HttpError) {
    return error.status;
  }

  if (error?.status === 429) {
    return 429;
  }

  if (typeof error?.status === "number" && error.status >= 400) {
    return 502;
  }

  return 500;
}

function getClientSafeErrorMessage(error) {
  if (error instanceof HttpError) {
    return error.message;
  }

  if (error?.status === 401 || error?.status === 403) {
    return "El servicio de IA no esta disponible ahora. Intenta de nuevo mas tarde.";
  }

  if (error?.status === 429) {
    return "El servicio de IA esta ocupado en este momento. Intenta de nuevo en un momento.";
  }

  if (typeof error?.status === "number" && error.status >= 500) {
    return "El servicio de IA no esta disponible ahora. Intenta de nuevo mas tarde.";
  }

  if (error?.code === "ETIMEDOUT" || error?.code === "ECONNRESET") {
    return "La conexion con el servicio de IA tardo demasiado. Intenta de nuevo.";
  }

  return "Ocurrio un error inesperado en el backend.";
}

function logServerError(error, route) {
  const status = error?.status ?? "no-status";
  const code = error?.code ?? "no-code";
  const message =
    error instanceof Error
      ? error.message
      : typeof error?.message === "string"
        ? error.message
        : String(error);

  console.error(`[${route}]`, {
    status,
    code,
    message
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
