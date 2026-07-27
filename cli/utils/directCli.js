import path from 'path';
import { fileURLToPath } from 'url';

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const DIRECT_CLI_PATH = path.resolve(moduleDirectory, '../../bin/ploinky-local');
