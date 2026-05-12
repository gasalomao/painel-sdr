import { NextResponse } from "next/server";
import { evolution } from "@/lib/evolution";

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const status = await evolution.getStatus();
    return NextResponse.json({ success: true, ...status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message, stack: err.stack }, { status: 500 });
  }
}
