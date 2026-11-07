/**
 * A real catalogue record, copied verbatim from data/charts/chart-4.jsonl.
 *
 * Every other chart fixture in this suite is a hand-written two- or three-node
 * graph, and that is precisely why the canvas shipped inert: a toy graph fits a
 * test viewport at scale >= 1, while a real one does not. This record carries
 * embedded n8n editor coordinates spanning 2,704 units across 15 nodes, which
 * is representative of the corpus (median graph width 2,516 units).
 *
 * Do not "simplify" it. Its awkward geometry is the point.
 */
import type { WorkflowChart } from '@hub/contracts';

export const CORPUS_CHART: WorkflowChart = {
  "nodes": [
    {
      "id": "sticky-main",
      "name": "Sticky Note",
      "type": "n8n-nodes-base.stickyNote",
      "x": -864,
      "y": -96
    },
    {
      "id": "sticky-trigger-config",
      "name": "Sticky Note1",
      "type": "n8n-nodes-base.stickyNote",
      "x": -304,
      "y": -80
    },
    {
      "id": "sticky-fetch",
      "name": "Sticky Note2",
      "type": "n8n-nodes-base.stickyNote",
      "x": 176,
      "y": -80
    },
    {
      "id": "sticky-caption",
      "name": "Sticky Note3",
      "type": "n8n-nodes-base.stickyNote",
      "x": 640,
      "y": -96
    },
    {
      "id": "sticky-publish",
      "name": "Sticky Note4",
      "type": "n8n-nodes-base.stickyNote",
      "x": 912,
      "y": -80
    },
    {
      "id": "trigger-1",
      "name": "Schedule Trigger",
      "type": "n8n-nodes-base.scheduleTrigger",
      "x": -260,
      "y": 80
    },
    {
      "id": "config-1",
      "name": "Config",
      "type": "n8n-nodes-base.set",
      "x": -20,
      "y": 80
    },
    {
      "id": "drive-search-1",
      "name": "Search files and folders",
      "type": "n8n-nodes-base.googleDrive",
      "x": 220,
      "y": 80
    },
    {
      "id": "drive-download-1",
      "name": "Download file",
      "type": "n8n-nodes-base.googleDrive",
      "x": 440,
      "y": 80
    },
    {
      "id": "gemini-analyze-1",
      "name": "Analyze an image",
      "type": "@n8n/n8n-nodes-langchain.googleGemini",
      "x": 688,
      "y": 80
    },
    {
      "id": "li-init-1",
      "name": "Init LinkedIn Upload",
      "type": "n8n-nodes-base.httpRequest",
      "x": 960,
      "y": 80
    },
    {
      "id": "li-reattach-1",
      "name": "Reattach Binary",
      "type": "n8n-nodes-base.code",
      "x": 1184,
      "y": 80
    },
    {
      "id": "li-upload-1",
      "name": "Upload LinkedIn Image",
      "type": "n8n-nodes-base.httpRequest",
      "x": 1408,
      "y": 80
    },
    {
      "id": "li-build-body-1",
      "name": "Build Post Body",
      "type": "n8n-nodes-base.code",
      "x": 1616,
      "y": 80
    },
    {
      "id": "li-post-1",
      "name": "Post to LinkedIn",
      "type": "n8n-nodes-base.httpRequest",
      "x": 1840,
      "y": 80
    }
  ],
  "edges": [
    {
      "from": "Analyze an image",
      "to": "Init LinkedIn Upload",
      "kind": "main"
    },
    {
      "from": "Build Post Body",
      "to": "Post to LinkedIn",
      "kind": "main"
    },
    {
      "from": "Config",
      "to": "Search files and folders",
      "kind": "main"
    },
    {
      "from": "Download file",
      "to": "Analyze an image",
      "kind": "main"
    },
    {
      "from": "Init LinkedIn Upload",
      "to": "Reattach Binary",
      "kind": "main"
    },
    {
      "from": "Reattach Binary",
      "to": "Upload LinkedIn Image",
      "kind": "main"
    },
    {
      "from": "Schedule Trigger",
      "to": "Config",
      "kind": "main"
    },
    {
      "from": "Search files and folders",
      "to": "Download file",
      "kind": "main"
    },
    {
      "from": "Upload LinkedIn Image",
      "to": "Build Post Body",
      "kind": "main"
    }
  ]
};
