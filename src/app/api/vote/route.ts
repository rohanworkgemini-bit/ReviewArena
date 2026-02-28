import { NextResponse } from "next/server";
import { recordVote } from "@/utils/queries";

export async function POST(req: Request) {
    try {
        const { comparison_id, winner } = await req.json();

        if (!comparison_id || !["A", "B", "tie"].includes(winner)) {
            return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
        }

        const result = await recordVote(comparison_id, winner);

        if (!result) {
            return NextResponse.json({ error: "Comparison not found" }, { status: 404 });
        }

        return NextResponse.json({ success: true, ...result });
    } catch (error) {
        console.error("Error submitting vote:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
