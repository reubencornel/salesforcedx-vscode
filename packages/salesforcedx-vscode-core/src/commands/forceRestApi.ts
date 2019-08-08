import {
  Command,
  SfdxCommandBuilder
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import {
  CancelResponse,
  ContinueResponse,
  ParametersGatherer
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import * as vscode from 'vscode';
import { nls } from '../messages';
// import { request } from 'http';
import {
  SfdxCommandlet,
  SfdxCommandletExecutor,
  SfdxWorkspaceChecker
} from './commands';
// import { start } from 'applicationinsights';

export interface ApiInput {
  method: string;
  uri: string;
  headers: string;
  body: string;
}

class ForceRestApiExecutor extends SfdxCommandletExecutor<{}> {
  public build(data: ApiInput): Command {
    const command = new SfdxCommandBuilder()
      .withDescription(nls.localize('force_rest_api_text'))
      .withArg('force:data:soql:query')
      .withFlag('--query', `'select id from Account'`)
      .withLogName('force_data_soql_query');
    return command.build();
  }
}

export class GetQueryAndApiInputs
  implements ParametersGatherer<ApiInput> {
  public async gather(): Promise<
    CancelResponse | ContinueResponse<ApiInput>> {
    const editor = await vscode.window.activeTextEditor;

    if (!editor) {
      return { type: 'CANCEL' };
    } else {
      const document = editor.document;
      const position = editor.selection.active;

      let text = '';
      // If the selection is empty, try to find the start to end end lines for the request.
      if (editor.selection.isEmpty) {
        // const startLinePosition = new Range(position.line, 0, position.line, 5000);
        const startPosition = new vscode.Position(position.line, 0);

        // find the part of the text that is the query.
        const requestRange: vscode.Range = findRequestRange(document, startPosition);
        text = document.getText(requestRange);
      } else {
        // use the text from the selection
        text = document.getText(editor.selection);
      }

      const result = parseStringBody(text);
      if (isError(result)) {
        vscode.window.showErrorMessage(result.message);
        return { type: 'CANCEL' };
      }

      vscode.window.showInformationMessage(result.method);
      vscode.window.showInformationMessage(result.uri);
      vscode.window.showInformationMessage(result.headers);
      vscode.window.showInformationMessage(result.body);

    }
    return { type: 'CANCEL' };
  }
}

type Result<T> = T | Error;
export type Type<T> = Result<T>;

export function isError<T>(result: Result<T>): result is Error {
  return result instanceof Error;
}

export function isSuccess<T>(result: Result<T>): result is T {
  return !isError(result);
}

function findRequestRange(doc: vscode.TextDocument, cursorPosition: vscode.Position): vscode.Range {
  let startPosition: vscode.Position = cursorPosition;
  let endPosition: vscode.Position = cursorPosition;

  // at this point we are at the start of the document do nothing
  if (startPosition.line !== 0) {
    // we are in the middle,
    // either go up to line 0 or find the line that starts with a rest method name.
    let startLine: number = startPosition.line;
    while (startLine >= 0) {
      if (startsWithRestMethod(getTextLine(doc, new vscode.Position(startLine, 0)))) {
        break;
      }
      startLine--;
    }
    if (startLine < 0) {
      startLine = 0;
    }
    startPosition = new vscode.Position(startLine, 0);
  }

  if (endPosition.line < doc.lineCount) {
    let endLine: number = endPosition.line;

    while (endLine < doc.lineCount) {
      if (startsWithHashes(getTextLine(doc, new vscode.Position(endLine, 0)))) {
        break;
      }
      endLine++;
    }
    endLine = endLine - 1;
    const r = new vscode.Range(endLine, 0, endLine, 50000);
    const r1 = doc.validateRange(r);
    endPosition = new vscode.Position(r1.end.line, r1.end.character);
  }

  return new vscode.Range(startPosition, endPosition);
}

function startsWithHashes(line: string): boolean {
  return line.startsWith('###');
}

function startsWithRestMethod(line: string): boolean {
  const methodNames = ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'DELETE'];
  for (const i in methodNames) {
    if (line.startsWith(methodNames[i])) {
      return true;
    }
  }
  return false;
}

function getTextLine(document: vscode.TextDocument, linePosition: vscode.Position): string {
  const range: vscode.Range = new vscode.Range(linePosition.line, 0, linePosition.line, 500000);
  const updatedRange = document.validateRange(range);
  return document.getText(updatedRange);
}

function parseStringBody(body: string): Result<ApiInput> {
  // The first line should be METHOD<SPACE>URL
  // tslint:disable-next-line:variable-name
  const methodName_body: Result<[string, string]> = findMethod(body); // methodName, restOfBody
  if (isError(methodName_body)) {
    return methodName_body;
  }

  // tslint:disable-next-line:variable-name
  const uri_body: Result<[string, string]> = findUri(methodName_body[1]);
  if (isError(uri_body)) {
    return uri_body;
  }

  // tslint:disable-next-line:variable-name
  const headers_body: Result<[string, string]> = findHeaders(uri_body[1]);
  if (isError(headers_body)) {
    return headers_body;
  }

  // Read the remaining lines, they should be of the format "key":"value"
  // till we encounter a line that is empty
  // The rest of the content is the body
  return { method: methodName_body[0], uri: uri_body[0], headers: headers_body[0], body: headers_body[1] };
}

// returns a json string with headers and the rest of the body
function findHeaders(body: string): Result<[string, string]> {
  const headersMap: Map<string, string> = new Map();
  const newline = '\n';
  let continueLoop = true;

  while (continueLoop) {
    const newLineLoc = body.indexOf(newline);
    const headerLine = body.substring(0, newLineLoc);
    if (headerLine.trim() === '') {
      continueLoop = false;
      body = body.substr(newLineLoc + 1, body.length);
      break;
    }
    // now parse the line
    const colonLoc = headerLine.indexOf(':');
    if (colonLoc < 0) {
      return new Error('Could not find :');
    }
    const key = headerLine.substr(0, colonLoc);
    const value = headerLine.substr(colonLoc + 1, headerLine.length);

    headersMap.set(key.trim(), value.trim());
    // update body.
    body = body.substr(newLineLoc + 1, body.length);
  }

  // check for zero size on header map
  let returnString = '';
  if (headersMap.size > 0) {
    returnString = '{';
    for (const entry of headersMap.entries()) {
      returnString = returnString + '"' + entry[0] + '":"' + entry[1] + '",';
    }

    returnString = returnString.substr(0, returnString.length - 1);
    returnString = returnString + '}';
  }

  return [returnString, body];
}

function findUri(body: string): Result<[string, string]> {
  const firstLineBreak = body.indexOf('\n');
  return [body.substring(0, firstLineBreak), body.substring(firstLineBreak + 1, body.length)];
}

function findMethod(body: string): Result<[string, string]> {
  const firstLineBreak = body.indexOf('\n');
  const firstLine = body.substring(0, firstLineBreak);
  const methodNames: string[] = ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'DELETE'];

  let i = 0;
  let index = 0;
  // tslint:disable-next-line:prefer-for-of
  for (i = 0; i < methodNames.length; i++) {
    index = firstLine.indexOf(methodNames[i]);
    if (index > -1) {
      break;
    }
  }

  if (i >= methodNames.length) {
    return new Error('Could not find method name');
  }

  index = index + methodNames[i].length;

  // consume all spaces after the method name.
  for (index; index < body.length; index++) {
    if (body.charAt(index) !== ' ' || body.charAt(index) !== '\t') {
      break;
    }
  }

  return [methodNames[i], body.substring(index, body.length)];
}

const workspaceChecker = new SfdxWorkspaceChecker();

export async function forceRestApi(explorerDir?: any) {
  const parameterGatherer = new GetQueryAndApiInputs();
  const commandlet = new SfdxCommandlet(
    workspaceChecker,
    parameterGatherer,
    new ForceRestApiExecutor()
  );
  await commandlet.run();
}
