declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { create?: boolean; readonly?: boolean; strict?: boolean })
    exec(sql: string): unknown
    query(sql: string): {
      run(...params: any[]): unknown
      get(...params: any[]): unknown
      all(...params: any[]): unknown[]
    }
    transaction<TArgs extends unknown[], TResult>(fn: (...args: TArgs) => TResult): (...args: TArgs) => TResult
  }
}
