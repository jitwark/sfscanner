import type { Metadata } from 'next';
import { WorkflowViewClient } from './view-client';
import { robotsMetadata } from '../../../src/seo/robots';

export const metadata: Metadata = {
  title: 'Workflow view · n8n-secureflow',
  robots: robotsMetadata(false),
};

export default function WorkflowViewPage() {
  return <WorkflowViewClient />;
}
