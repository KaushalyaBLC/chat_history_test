import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const token = process.env.access_token;

    if (!token) {
      return NextResponse.json(
        { error: 'Access token not configured' },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const projectSlug = searchParams.get('projectSlug')?.trim();
    if (!projectSlug) {
      return NextResponse.json(
        { error: 'Project slug is required' },
        { status: 400 }
      );
    }
    const page = searchParams.get('page') ?? '1';
    const limit = searchParams.get('limit') ?? '20';
    const baseUrl = `https://dev.api.olee.ai/v4/oleon/convos/${projectSlug}/history/snapshots`;

    const url = `${baseUrl}?page=${encodeURIComponent(page)}&limit=${encodeURIComponent(limit)}`;

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorData = await response.text();
      return NextResponse.json(
        { error: 'Failed to fetch snapshots', details: errorData },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);
  } catch (error) {
    console.error('Error fetching snapshots:', error);
    return NextResponse.json(
      { error: 'Internal server error', message: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
