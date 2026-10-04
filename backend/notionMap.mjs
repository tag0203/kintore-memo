/**
 * Notion payload mapping for the Lambda wrapper.
 * Port of worker/notionMap.ts. worker/ stays a reference and is not the production path.
 * Property names match README「Notion の形」.
 */

export const NOTION_VERSION = "2026-03-11";

export const PAGE_TITLE = "－";

export const DIFFICULTY_LABELS = Object.freeze({
  1: "とても楽",
  2: "楽",
  3: "ややきつい",
  4: "きつい",
  5: "とてもきつい",
});

export const PROPERTIES = Object.freeze({
  exercise: "種目",
  weight: "重量（kg）",
  reps: "回数",
  sets: "セット数",
  difficulty: "きつさ",
  date: "日付",
});

const EXPECTED_TYPES = Object.freeze([
  [PROPERTIES.exercise, "select"],
  [PROPERTIES.weight, "number"],
  [PROPERTIES.reps, "number"],
  [PROPERTIES.sets, "number"],
  [PROPERTIES.difficulty, "select"],
  [PROPERTIES.date, "date"],
]);

const LABEL_TO_DIFFICULTY = new Map(
  Object.entries(DIFFICULTY_LABELS).map(([level, label]) => [label, Number(level)]),
);

export function assertWorkoutSchema(properties) {
  const titleProperty = Object.entries(properties).find(([, property]) => property?.type === "title")?.[0];
  if (!titleProperty) throw new Error("タイトルプロパティが見つかりません");

  for (const [name, type] of EXPECTED_TYPES) {
    const property = properties[name];
    if (!property) throw new Error(`プロパティ「${name}」がありません`);
    if (property.type !== type) {
      throw new Error(`プロパティ「${name}」の型は ${type} にしてください（今は ${property.type ?? "不明"}）`);
    }
  }

  return { titleProperty };
}

export function exerciseNamesFromSchema(properties) {
  const options = properties[PROPERTIES.exercise]?.select?.options ?? [];
  const names = [];
  for (const option of options) {
    const name = option?.name?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function buildPreviousQuery(exercise, beforeDate) {
  return {
    filter: {
      and: [
        { property: PROPERTIES.exercise, select: { equals: exercise } },
        { property: PROPERTIES.date, date: { before: beforeDate } },
      ],
    },
    sorts: [
      { property: PROPERTIES.date, direction: "descending" },
      { timestamp: "created_time", direction: "descending" },
    ],
    page_size: 100,
  };
}

export function buildOnDateQuery(exercise, date) {
  return {
    filter: {
      and: [
        { property: PROPERTIES.exercise, select: { equals: exercise } },
        { property: PROPERTIES.date, date: { equals: date } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
    page_size: 100,
  };
}

/** Newest logs across the database. Bootstrap derives previous/today from this window. */
export const RECENT_PAGE_SIZE = 100;

export function buildRecentQuery() {
  return {
    sorts: [
      { property: PROPERTIES.date, direction: "descending" },
      { timestamp: "created_time", direction: "descending" },
    ],
    page_size: RECENT_PAGE_SIZE,
  };
}

export function buildCreatePageBody(dataSourceId, titleProperty, input) {
  const title = input.title?.trim() || PAGE_TITLE;
  return {
    parent: { type: "data_source_id", data_source_id: dataSourceId },
    properties: {
      [titleProperty]: {
        type: "title",
        title: [{ type: "text", text: { content: title } }],
      },
      [PROPERTIES.exercise]: { type: "select", select: { name: input.exercise } },
      [PROPERTIES.weight]: { type: "number", number: input.weightKg },
      [PROPERTIES.reps]: { type: "number", number: input.reps },
      [PROPERTIES.sets]: { type: "number", number: input.sets },
      [PROPERTIES.difficulty]: {
        type: "select",
        select: { name: DIFFICULTY_LABELS[input.difficulty] },
      },
      [PROPERTIES.date]: { type: "date", date: { start: input.date } },
    },
  };
}

function readTitle(property) {
  if (!property || typeof property !== "object") return "";
  const title = property.title;
  if (!Array.isArray(title)) return "";
  return title.map((item) => item?.plain_text ?? "").join("");
}

function readSelect(property) {
  if (!property || typeof property !== "object") return null;
  const name = property.select?.name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function readNumber(property) {
  if (!property || typeof property !== "object") return null;
  return typeof property.number === "number" ? property.number : null;
}

function readDate(property) {
  if (!property || typeof property !== "object") return null;
  const start = property.date?.start;
  return typeof start === "string" && start ? start.slice(0, 10) : null;
}

/** Frontend ExerciseLog. Incomplete Notion rows are skipped. */
export function pageToLog(page, titleProperty) {
  const properties = page?.properties ?? {};
  const exercise = readSelect(properties[PROPERTIES.exercise]);
  const weightKg = readNumber(properties[PROPERTIES.weight]);
  const reps = readNumber(properties[PROPERTIES.reps]);
  const sets = readNumber(properties[PROPERTIES.sets]);
  const difficultyLabel = readSelect(properties[PROPERTIES.difficulty]);
  const date = readDate(properties[PROPERTIES.date]);
  if (!exercise || weightKg == null || reps == null || sets == null || !difficultyLabel || !date) {
    return null;
  }
  const difficulty = LABEL_TO_DIFFICULTY.get(difficultyLabel);
  if (!difficulty || !Number.isInteger(reps) || !Number.isInteger(sets)) return null;

  return {
    id: page.id,
    exercise,
    weightKg,
    reps,
    sets,
    difficulty,
    date,
    title: readTitle(properties[titleProperty]) || PAGE_TITLE,
    createdAt: page.created_time ?? new Date(0).toISOString(),
  };
}
