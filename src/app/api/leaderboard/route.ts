import { NextResponse } from "next/server";
import { getLeaderboard } from "@/utils/queries";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const leaderboard = await getLeaderboard();
        return NextResponse.json(leaderboard);
    } catch (error) {
        console.error("Error fetching leaderboard:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
