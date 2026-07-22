export class PloinkyBoxError extends Error {
    constructor(message, { code = 'PLOINKY_BOX_ERROR', cause } = {}) {
        super(message, { cause });
        this.name = this.constructor.name;
        this.code = code;
    }
}

export class BoundaryViolationError extends PloinkyBoxError {
    constructor(message, options = {}) {
        super(message, {
            ...options,
            code: options.code ?? 'PLOINKY_BOX_BOUNDARY_VIOLATION',
        });
    }
}
