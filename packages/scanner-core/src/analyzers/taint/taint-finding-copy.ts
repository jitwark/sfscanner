import type { TaintSinkKind } from './taint-lattice';

export type SinkNarrative = {
  title: string;
  message: string;
  explanation: string;
  whyItMatters: string;
  possibleImpact: string;
  remediation: string;
  remediationSteps: string[];
};

const reviewStep = 'Confirm the upstream data is validated against an allowlist before it reaches this node.';

export const SINK_NARRATIVES: Record<TaintSinkKind, SinkNarrative> = {
  COMMAND: {
    title: 'Untrusted data reaches a shell command',
    message: 'This shell command is built from data that entered the workflow from outside.',
    explanation: 'A parameter interpreted as a shell command reads from a node carrying untrusted input, and the expression does not neutralize it for that use.',
    whyItMatters: 'Shell commands assembled from external input are the shortest path from workflow automation to the host environment.',
    possibleImpact: 'A caller who controls the upstream data may be able to influence which command runs.',
    remediation: 'Pass untrusted values as arguments to a fixed command rather than building the command string.',
    remediationSteps: ['Build the command from a fixed template and pass data as separate arguments.', reviewStep],
  },
  SQL: {
    title: 'Untrusted data reaches a SQL query',
    message: 'This SQL query is built from data that entered the workflow from outside.',
    explanation: 'A parameter interpreted as SQL reads from a node carrying untrusted input, and no wrapper call can make a value safe for SQL.',
    whyItMatters: 'String-built SQL is the classic injection path, and encoding helpers do not close it.',
    possibleImpact: 'A caller who controls the upstream data may be able to change what the query reads or writes.',
    remediation: 'Use query parameters instead of interpolating values into the statement.',
    remediationSteps: ['Replace interpolation with the node\'s parameterized query option.', reviewStep],
  },
  SSRF: {
    title: 'Untrusted data reaches a request URL',
    message: 'This request URL is built from data that entered the workflow from outside.',
    explanation: 'A parameter interpreted as a request destination reads from a node carrying untrusted input. Percent-encoding a component does not constrain the host.',
    whyItMatters: 'A caller who influences the destination can redirect the request to internal services the workflow can reach but they cannot.',
    possibleImpact: 'The workflow may issue requests to unintended internal or external hosts on a caller\'s behalf.',
    remediation: 'Fix the host and path, and allow untrusted data only in values the destination cannot change.',
    remediationSteps: ['Pin the host and path, and pass untrusted values as query or body parameters.', reviewStep],
  },
  HEADER: {
    title: 'Untrusted data reaches a request header',
    message: 'This request header value is built from data that entered the workflow from outside.',
    explanation: 'A parameter interpreted as a header value reads from a node carrying untrusted input without an encoding that removes control characters.',
    whyItMatters: 'Header values carry authentication and routing meaning, and unencoded control characters can split a request.',
    possibleImpact: 'A caller who controls the upstream data may be able to add or alter headers on the outbound request.',
    remediation: 'Encode the value, or send untrusted data in the body instead of a header.',
    remediationSteps: ['Percent-encode the value before placing it in a header.', reviewStep],
  },
  PATH: {
    title: 'Untrusted data reaches a filesystem path',
    message: 'This file path is built from data that entered the workflow from outside.',
    explanation: 'A parameter interpreted as a filesystem path reads from a node carrying untrusted input. Percent-encoding does not help, because the path is decoded before use.',
    whyItMatters: 'Path segments from outside the workflow can escape the directory the automation was meant to touch.',
    possibleImpact: 'The workflow may read or write files outside its intended location.',
    remediation: 'Derive the path from a fixed directory plus a validated identifier.',
    remediationSteps: ['Join a fixed base directory with a validated identifier rather than an external string.', reviewStep],
  },
  CODE: {
    title: 'Untrusted data is interpolated into custom code',
    message: 'This code parameter is built from data that entered the workflow from outside.',
    explanation: 'An expression interpolates untrusted data into a code parameter before the code node runs, so the executed source is not fixed at review time.',
    whyItMatters: 'Code assembled at run time cannot be reviewed, and the review that did happen covered a different program.',
    possibleImpact: 'The code that executes may differ from the code that was reviewed.',
    remediation: 'Read untrusted data inside the code from the incoming item instead of interpolating it into the source.',
    remediationSteps: ['Reference the incoming item inside the code rather than building the source from an expression.', reviewStep],
  },
  PROMPT: {
    title: 'Untrusted data reaches a model prompt',
    message: 'This model prompt is built from data that entered the workflow from outside.',
    explanation: 'A parameter interpreted as a prompt reads from a node carrying untrusted input, so instructions can arrive with the data.',
    whyItMatters: 'A model cannot reliably separate instructions from content, and this agent may hold tools.',
    possibleImpact: 'A caller who controls the upstream data may be able to influence what the model is asked to do.',
    remediation: 'Keep untrusted content in a clearly delimited field and constrain the tools the agent can reach.',
    remediationSteps: ['Place untrusted content in a delimited input field separate from the instructions.', 'Limit which tools the agent can invoke.'],
  },
};
