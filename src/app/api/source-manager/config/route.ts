/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { AdminConfig } from '@/lib/admin.types';
import { persistAdminConfigMutation } from '@/lib/admin-config-mutation';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/source-manager/config
 * 读取当前完整配置（本地模式返回内存配置，数据库模式返回数据库配置）。
 * 该接口在 public 免登录模式下由 proxy.ts 白名单放行，仅供本机桌面端使用。
 */
export async function GET() {
  try {
    const config = await getConfig();
    return NextResponse.json(
      { success: true, config },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    console.error('[SourceManager] 读取配置失败:', error);
    return NextResponse.json({ error: '读取配置失败' }, { status: 500 });
  }
}

/**
 * POST /api/source-manager/config
 * 保存完整配置。请求体：{ config: AdminConfig }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const config = body.config as AdminConfig;
    if (!config || !Array.isArray(config.SourceConfig)) {
      return NextResponse.json({ error: '配置数据无效' }, { status: 400 });
    }
    const persisted = await persistAdminConfigMutation(config);
    return NextResponse.json({
      success: true,
      message: '配置已保存',
      sourceCount: persisted.SourceConfig?.length || 0,
      liveCount: persisted.LiveConfig?.length || 0,
    });
  } catch (error) {
    console.error('[SourceManager] 保存配置失败:', error);
    return NextResponse.json({ error: '保存配置失败' }, { status: 500 });
  }
}
