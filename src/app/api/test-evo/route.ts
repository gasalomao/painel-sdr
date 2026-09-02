import { NextRequest, NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/auth";
import { evolution } from "@/lib/evolution";

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) {
    return NextResponse.json({ success: false, error: "Apenas admin" }, { status: 403 });
  }
  try {
    const status = await evolution.getStatus();
    return NextResponse.json({ success: true, ...status });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "erro" }, { status: 500 });
  }
}
