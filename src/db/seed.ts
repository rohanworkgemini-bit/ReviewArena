import "dotenv/config";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql, schema });

async function seed() {
    console.log("Seeding database...");

    // Clear existing data
    await db.delete(schema.votes);
    await db.delete(schema.comparisons);
    await db.delete(schema.reviews);
    await db.delete(schema.models);

    // Insert Models
    const generatedModels = await db.insert(schema.models).values([
        { name: "GPT-4" },
        { name: "Claude 3 Opus" },
        { name: "Gemini 1.5 Pro" },
    ]).returning();

    console.log("Inserted models:", generatedModels.map(m => m.name));

    const gpt = generatedModels.find((m) => m.name === "GPT-4")!;
    const claude = generatedModels.find((m) => m.name === "Claude 3 Opus")!;
    const gemini = generatedModels.find((m) => m.name === "Gemini 1.5 Pro")!;

    // Insert Reviews for a specific fake prompt: "Write a short poem about coding."
    const generatedReviews = await db.insert(schema.reviews).values([
        {
            modelId: gpt.id,
            text: "Keys clicking softly in the night,\nLines of logic, pure and bright.\nA puzzle solved, a bug squashed flat,\nI tip to code my virtual hat.",
        },
        {
            modelId: claude.id,
            text: "Syntax woven, ideas take flight,\nOn glowing screens in the dead of night.\nWe build the worlds that yet will be,\nIn loops and forms of logic's key.",
        },
        {
            modelId: gemini.id,
            text: "Blank screen waiting, cursor blinks,\nA quiet mind that problem-thinks.\nFrom functions to the final build,\nThe coder's destiny fulfilled.",
        },
        // Another set of reviews for: "Explain recursion simply."
        {
            modelId: gpt.id,
            text: "Recursion is like looking at a mirror in a mirror. You see a smaller reflection repeating endlessly until it hits the frame. In code, it's a function calling itself until it reaches a stopping point.",
        },
        {
            modelId: claude.id,
            text: "Imagine you have a big treasure box. Inside is a smaller box, and inside that, another box, until you find the treasure in the smallest box. Recursion is opening boxes using the same method until you find the goal.",
        },
        {
            modelId: gemini.id,
            text: "To understand recursion, you must first understand recursion. Jokes aside, it's a technique where a function solves a small part of a task, then calls itself to handle the rest, stopping when the task is done.",
        }
    ]).returning();

    console.log(`Inserted ${generatedReviews.length} reviews.`);

    // Create active comparisons (combinations of the reviews for same prompts)
    await db.insert(schema.comparisons).values([
        { reviewAId: generatedReviews[0].id, reviewBId: generatedReviews[1].id },
        { reviewAId: generatedReviews[1].id, reviewBId: generatedReviews[2].id },
        { reviewAId: generatedReviews[3].id, reviewBId: generatedReviews[5].id },
        { reviewAId: generatedReviews[4].id, reviewBId: generatedReviews[5].id },
    ]);

    console.log("Inserted comparisons.");
    console.log("Database seeded successfully.");
}

seed().catch((err) => {
    console.error("Error seeding database:", err);
    process.exit(1);
});
