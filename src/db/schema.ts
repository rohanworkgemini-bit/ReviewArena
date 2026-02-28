import { pgTable, serial, text, uuid, boolean, integer, timestamp } from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const models = pgTable("models", {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull().unique(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const reviews = pgTable("reviews", {
    id: uuid("id").primaryKey().defaultRandom(),
    modelId: uuid("model_id").references(() => models.id, { onDelete: "cascade" }).notNull(),
    text: text("text").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const comparisons = pgTable("comparisons", {
    id: serial("id").primaryKey(),
    reviewAId: uuid("review_a_id").references(() => reviews.id, { onDelete: "cascade" }).notNull(),
    reviewBId: uuid("review_b_id").references(() => reviews.id, { onDelete: "cascade" }).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const votes = pgTable("votes", {
    id: uuid("id").primaryKey().defaultRandom(),
    comparisonId: integer("comparison_id").references(() => comparisons.id, { onDelete: "cascade" }).notNull(),
    winnerModelId: uuid("winner_model_id").references(() => models.id, { onDelete: "set null" }), // Null if tie
    loserModelId: uuid("loser_model_id").references(() => models.id, { onDelete: "set null" }), // Null if tie
    isTie: boolean("is_tie").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
});


export const modelsRelations = relations(models, ({ many }) => ({
    reviews: many(reviews),
    wonVotes: many(votes, { relationName: "winner" }),
    lostVotes: many(votes, { relationName: "loser" }),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
    model: one(models, {
        fields: [reviews.modelId],
        references: [models.id],
    }),
}));

export const comparisonsRelations = relations(comparisons, ({ one, many }) => ({
    reviewA: one(reviews, {
        fields: [comparisons.reviewAId],
        references: [reviews.id],
        relationName: "reviewA",
    }),
    reviewB: one(reviews, {
        fields: [comparisons.reviewBId],
        references: [reviews.id],
        relationName: "reviewB",
    }),
    votes: many(votes),
}));

export const votesRelations = relations(votes, ({ one }) => ({
    comparison: one(comparisons, {
        fields: [votes.comparisonId],
        references: [comparisons.id],
    }),
    winner: one(models, {
        fields: [votes.winnerModelId],
        references: [models.id],
        relationName: "winner",
    }),
    loser: one(models, {
        fields: [votes.loserModelId],
        references: [models.id],
        relationName: "loser",
    }),
}));
