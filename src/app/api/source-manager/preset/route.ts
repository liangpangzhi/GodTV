import { NextResponse } from 'next/server';

import { getPresetLives, getPresetSources } from '@/lib/preset-config';

export const runtime = 'nodejs';

/** GET /api/source-manager/preset — 返回编译内置的预置源，用于恢复 */
export async function GET() {
  return NextResponse.json({
    success: true,
    sources: getPresetSources(),
    lives: getPresetLives(),
  });
}
