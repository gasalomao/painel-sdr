import { NextRequest, NextResponse } from "next/server";
import { submitWebsiteForm, websiteFormPreflight } from "@/lib/sites/forms";

export const runtime = "nodejs";

export async function POST(req: NextRequest): Promise<NextResponse> {
  return submitWebsiteForm(req);
}

export async function OPTIONS(req: NextRequest): Promise<NextResponse> {
  return websiteFormPreflight(req);
}
