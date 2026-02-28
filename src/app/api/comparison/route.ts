import { NextResponse } from "next/server";
import { getRandomComparison } from "@/utils/queries";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        const comparison = await getRandomComparison();

        if (!comparison) {
            return NextResponse.json({ error: "No comparisons found" }, { status: 404 });
        }

        return NextResponse.json(comparison);
    } catch (error) {
        console.error("Error fetching comparison:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
