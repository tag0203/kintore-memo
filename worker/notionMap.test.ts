import { describe, expect, it } from "vitest";
import {
  PROPERTIES,
  assertWorkoutSchema,
  buildCreatePageBody,
  buildPreviousQuery,
  exerciseNamesFromSchema,
  pageToLog,
  type NotionPropertySchema,
} from "./notionMap";

const schema: Record<string, NotionPropertySchema> = {
  名前: { type: "title" },
  種目: {
    type: "select",
    select: { options: [{ name: "スクワット" }, { name: "ベンチプレス" }] },
  },
  "重量（kg）": { type: "number" },
  回数: { type: "number" },
  セット数: { type: "number" },
  きつさ: { type: "select", select: { options: [{ name: "ややきつい" }] } },
  日付: { type: "date" },
};

const page = {
  id: "page-1",
  created_time: "2026-09-25T12:10:00.000Z",
  properties: {
    名前: { title: [{ plain_text: "－" }] },
    種目: { select: { name: "スクワット" } },
    "重量（kg）": { number: 80 },
    回数: { number: 11 },
    セット数: { number: 3 },
    きつさ: { select: { name: "ややきつい" } },
    日付: { date: { start: "2026-09-25" } },
  },
};

describe("Notion payload mapping", () => {
  it("requires the workout columns and discovers the title property", () => {
    expect(assertWorkoutSchema(schema)).toEqual({ titleProperty: "名前" });
    expect(exerciseNamesFromSchema(schema)).toEqual(["スクワット", "ベンチプレス"]);
    expect(() => assertWorkoutSchema({ 名前: { type: "title" } })).toThrow("プロパティ「種目」がありません");
  });

  it("queries the latest row before today and creates one page per save", () => {
    expect(buildPreviousQuery("スクワット", "2026-09-26").filter.and[1]).toEqual({
      property: PROPERTIES.date,
      date: { before: "2026-09-26" },
    });

    const body = buildCreatePageBody("ds-1", "名前", {
      exercise: "スクワット",
      weightKg: 82.5,
      reps: 8,
      sets: 3,
      difficulty: 4,
      date: "2026-09-26",
    });

    expect(body.parent).toEqual({ type: "data_source_id", data_source_id: "ds-1" });
    const properties = body.properties as Record<string, { title?: { text: { content: string } }[] }>;
    expect(properties["名前"]?.title?.[0]?.text.content).toBe("－");
    expect(properties["きつさ"]).toEqual({ type: "select", select: { name: "きつい" } });
    expect(pageToLog(page, "名前")).toMatchObject({
      exercise: "スクワット",
      weightKg: 80,
      reps: 11,
      sets: 3,
      difficulty: 3,
      date: "2026-09-25",
      title: "－",
    });
  });
});
