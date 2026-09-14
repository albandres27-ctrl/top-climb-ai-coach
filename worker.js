/**
 * Version 100% gratuite du serveur IA pour Top Climb.
 *
 * Au lieu d'appeler l'API Anthropic (payante), ce Worker utilise Cloudflare
 * Workers AI avec un modèle open-source (Llama 3.1), inclus gratuitement :
 *   - 10 000 "Neurons" par jour, sans carte bancaire
 *   - hébergement du Worker lui-même gratuit (100 000 requêtes/jour)
 *
 * Qualité : un peu en retrait par rapport à Claude sur des retours très fins,
 * mais largement suffisant pour un bilan technique, un planning ou un
 * échauffement structuré.
 *
 * Déploiement (aucune carte bancaire nécessaire) :
 *   1. npm install -g wrangler
 *   2. wrangler login   (connecte ton compte Cloudflare gratuit)
 *   3. Depuis ce dossier : wrangler deploy
 *   4. Tu obtiens une URL du type https://top-climb-ai-coach.<ton-compte>.workers.dev
 *   5. Dans le fichier top-climb-app.html, remplace AI_ENDPOINT par
 *      "https://top-climb-ai-coach.<ton-compte>.workers.dev/api/ai-coach"
 */

const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function extractJSON(text) {
  if (text && typeof text === "object") return text;
  const cleaned = String(text).replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("Aucun JSON trouvé dans la réponse: " + cleaned.slice(0, 300));
  return JSON.parse(cleaned.slice(start, end + 1));
}

// Utilise le "JSON Mode" de Cloudflare Workers AI : on fournit un schéma JSON et
// le modèle est contraint de répondre exactement dans cette forme, au lieu de
// simplement lui demander en texte de "répondre en JSON" (ce qui échouait parfois).
async function askModel(env, systemPrompt, userPrompt, jsonSchema) {
  const result = await env.AI.run(MODEL, {
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 2000,
    response_format: jsonSchema
      ? { type: "json_schema", json_schema: jsonSchema }
      : undefined,
  });
  if (result && typeof result.response === "string") return result.response;
  if (result && typeof result.response === "object" && result.response !== null) return result.response;
  if (result && result.error) throw new Error(String(result.error));
  return result || "";
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "JSON invalide" }, { status: 400, headers: corsHeaders() });
    }

    const { type, data } = body || {};

    try {
      if (type === "bilan_video") {
        const system =
          "Tu es un coach d'escalade expérimenté. On te donne une liste de points techniques " +
          "cochés par un grimpeur après avoir revisionné une vidéo de son essai, ainsi que des " +
          "notes horodatées prises pendant le visionnage. Rédige un bilan court, concret et " +
          "bienveillant (8 à 12 lignes), qui priorise 2 à 3 axes de travail et propose un exercice " +
          "ou repère concret pour chacun. Réponds UNIQUEMENT avec un JSON de la forme " +
          '{"text": "..."} — rien d\'autre, pas de balises markdown.';
        const user = `Points techniques cochés: ${JSON.stringify(
          data.pointsGeneraux || []
        )}\nNotes horodatées: ${JSON.stringify(data.notesHorodatees || [])}`;
        const schema = {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
        };
        const raw = await askModel(env, system, user, schema);
        return Response.json(extractJSON(raw), { headers: corsHeaders() });
      }

      if (type === "plan_entrainement") {
        const system =
          "Tu es un coach d'escalade qui construit des plannings d'entraînement hebdomadaires. " +
          "On te donne une description libre du grimpeur (niveau, objectifs, jours/horaires " +
          "disponibles) et éventuellement son planning actuel. Construis un planning réaliste, " +
          "sans surentraînement (jamais plus d'une séance intense par jour, au moins 1 jour de " +
          "repos complet par semaine). Réponds UNIQUEMENT avec un JSON de la forme " +
          '{"schedule": {"lundi": [{"time":"18:00","endTime":"19:30","label":"..."}], "mardi": [], ' +
          '"mercredi": [], "jeudi": [], "vendredi": [], "samedi": [], "dimanche": []}} — les 7 clés ' +
          "doivent toutes être présentes (tableau vide si jour de repos), horaires au format HH:MM, " +
          "rien d'autre que ce JSON.";
        const user = `Description du grimpeur: ${data.description}\nPlanning actuel (peut être vide): ${JSON.stringify(
          data.planningActuel || {}
        )}`;
        const jour = {
          type: "array",
          items: {
            type: "object",
            properties: {
              time: { type: "string" },
              endTime: { type: "string" },
              label: { type: "string" },
            },
            required: ["time", "endTime", "label"],
          },
        };
        const schema = {
          type: "object",
          properties: {
            schedule: {
              type: "object",
              properties: {
                lundi: jour,
                mardi: jour,
                mercredi: jour,
                jeudi: jour,
                vendredi: jour,
                samedi: jour,
                dimanche: jour,
              },
              required: ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"],
            },
          },
          required: ["schedule"],
        };
        const raw = await askModel(env, system, user, schema);
        return Response.json(extractJSON(raw), { headers: corsHeaders() });
      }

      if (type === "echauffement") {
        const system =
          "Tu es un coach d'escalade spécialisé dans l'échauffement. On te donne le niveau du " +
          "grimpeur, le type de séance prévue, le temps disponible en minutes, et une bibliothèque " +
          "d'exercices déjà disponibles dans l'app (nom, catégorie, durée par défaut en secondes). " +
          "Choisis et réordonne UNIQUEMENT des exercices présents dans cette bibliothèque — n'en " +
          "invente aucun nouveau et n'écris que des noms qui apparaissent exactement dans la liste " +
          "fournie. Construis une séquence adaptée (mobilité générale d'abord, puis spécifique " +
          "doigts/avant-bras, puis activation progressive) qui tient dans le temps donné en comptant " +
          "~10s de repos entre chaque étape. Tu peux ajuster légèrement la durée de chaque exercice " +
          'si besoin, mais garde le nom et la catégorie exacts. Réponds UNIQUEMENT avec un JSON de ' +
          'la forme {"items": [{"label":"...", "categoryLabel":"...", "seconds": 30}, ...]} — rien ' +
          "d'autre que ce JSON.";
        const user = `Niveau: ${data.niveau || "non précisé"}\nType de séance: ${
          data.typeSeance || "non précisé"
        }\nTemps disponible: ${data.dureeMinutes || 15} minutes\nBibliothèque d'exercices disponibles: ${JSON.stringify(
          data.bibliotheque || []
        )}`;
        const bibliotheque = data.bibliotheque || [];
        const nomsAutorises = bibliotheque.map((ex) => ex.name).filter(Boolean);
        const labelSchema =
          nomsAutorises.length > 0
            ? { type: "string", enum: nomsAutorises }
            : { type: "string" };
        const schema = {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  label: labelSchema,
                  categoryLabel: { type: "string" },
                  seconds: { type: "number" },
                },
                required: ["label", "categoryLabel", "seconds"],
              },
            },
          },
          required: ["items"],
        };
        const raw = await askModel(env, system, user, schema);
        const parsed = extractJSON(raw);
        // Filet de sécurité supplémentaire : même avec le schéma, on retire toute
        // ligne dont le nom ne correspond à aucun exercice de la bibliothèque, et
        // on recolle la bonne catégorie (celle de la bibliothèque, pas celle que
        // le modèle a pu inventer).
        if (nomsAutorises.length > 0 && Array.isArray(parsed.items)) {
          const parCategorie = new Map(bibliotheque.map((ex) => [ex.name, ex.categoryLabel]));
          parsed.items = parsed.items
            .filter((it) => parCategorie.has(it.label))
            .map((it) => ({ ...it, categoryLabel: parCategorie.get(it.label) }));
        }
        return Response.json(parsed, { headers: corsHeaders() });
      }

      return Response.json({ error: "type inconnu" }, { status: 400, headers: corsHeaders() });
    } catch (err) {
      return Response.json(
        { error: "Erreur lors de la génération IA", details: String(err) },
        { status: 500, headers: corsHeaders() }
      );
    }
  },
};
               
