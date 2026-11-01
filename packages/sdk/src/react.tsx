'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { captureAdapted } from './adapters.js';
import type { CaptureContext, TelemetryClient } from './types.js';

export interface TelemetryErrorBoundaryProps {
  client: TelemetryClient;
  children: ReactNode;
  fallback: ReactNode;
  context?: CaptureContext;
  resetKey?: string | number;
}

export class TelemetryErrorBoundary extends Component<
  TelemetryErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    captureAdapted(this.props.client, error, this.props.context, 'react_boundary', false);
  }

  componentDidUpdate(previous: TelemetryErrorBoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed)
      this.setState({ failed: false });
  }

  render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
