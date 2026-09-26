import {
  DIFFICULTY_LABELS,
  PAGE_TITLE,
  difficultyFromLabel,
  type ExerciseLog,
  type NewExerciseLog,
} from "../src/domain";

/** Notion API 2026-03-11。データベースの先にあるデータソースを読む。 */
export const NOTION_VERSION = "2026-03-11";

/** データベースのプロパティ名。括弧は全角。 */
export const PROPERTIES = {
  exercise: "種目",
  weight: "重量（kg）",
  reps: "回数",
  sets: "セット数",
  difficulty: "きつさ",
  date: "日付",
} as const;

export interface NotionPropertySchema {
  type?: string;
  select?: { options?: { name?: string }[] };
}

export interface NotionPageLike {
  id: string;
  created_time?: string;
  properties: Record<string, unknown>;
}

const EXPECTED_TYPES: readonly [string, string][] = [
  [PROPERTIES.exercise, "select"],
  [PROPERTIES.weight, "number"],
  [PROPERTIES.reps, "number"],
  [PROPERTIES.sets, "number"],
  [PROPERTIES.difficulty, "select"],
  [PROPERTIES.date, "date"],
];

export function assertWorkoutSchema(properties: Record<string, NotionPropertySchema>): {
  titleProperty: string;
} {
  const titleProperty = Object.entries(properties).find(([, property]) => property.type === "title")?.[0];
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

export function exerciseNamesFromSchema(properties: Record<string, NotionPropertySchema>): string[] {
  const options = properties[PROPERTIES.exercise]?.select?.options ?? [];
  const names: string[] = [];
  for (const option of options) {
    const name = option.name?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

export function buildPreviousQuery(exercise: string, beforeDate: string) {
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
    page_size: 1,
  };
}

export function buildOnDateQuery(exercise: string, date: string) {
  return {
    filter: {
      and: [
        { property: PROPERTIES.exercise, select: { equals: exercise } },
        { property: PROPERTIES.date, date: { equals: date } },
      ],
    },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 1,
  };
}

export function buildRecentQuery() {
  return {
    sorts: [
      { property: PROPERTIES.date, direction: "descending" },
      { timestamp: "created_time", direction: "descending" },
    ],
    page_size: 100,
  };
}

export function buildCreatePageBody(
  dataSourceId: string,
  titleProperty: string,
  input: NewExerciseLog,
): Record<string, unknown> {
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

function readTitle(property: unknown): string {
  if (!property || typeof property !== "object") return "";
  const title = (property as { title?: { plain_text?: string }[] }).title;
  if (!Array.isArray(title)) return "";
  return title.map((item) => item.plain_text ?? "").join("");
}

function readSelect(property: unknown): string | null {
  if (!property || typeof property !== "object") return null;
  const name = (property as { select?: { name?: string } | null }).select?.name;
  return name?.trim() || null;
}

function readNumber(property: unknown): number | null {
  if (!property || typeof property !== "object") return null;
  const value = (property as { number?: number | null }).number;
  return typeof value === "number" ? value : null;
}

function readDate(property: unknown): string | null {
  if (!property || typeof property !== "object") return null;
  const start = (property as { date?: { start?: string } | null }).date?.start;
  return start ? start.slice(0, 10) : null;
}

export function pageToLog(page: NotionPageLike, titleProperty: string): ExerciseLog | null {
  const properties = page.properties;
  const exercise = readSelect(properties[PROPERTIES.exercise]);
  const weightKg = readNumber(properties[PROPERTIES.weight]);
  const reps = readNumber(properties[PROPERTIES.reps]);
  const sets = readNumber(properties[PROPERTIES.sets]);
  const difficultyLabel = readSelect(properties[PROPERTIES.difficulty]);
  const date = readDate(properties[PROPERTIES.date]);
  if (!exercise || weightKg == null || reps == null || sets == null || !difficultyLabel || !date) {
    return null;
  }
  const difficulty = difficultyFromLabel(difficultyLabel);
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
