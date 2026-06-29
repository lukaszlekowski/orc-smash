/**
 * Shared command result contract.
 *
 * Invariant exit-code mappings:
 * - successful `smash` run => `exitCode: 0`
 * - `smash` run that stops on terminal `unknown` verdict => `exitCode: 1`
 * - `smash` run that ends due to max-iteration `REJECTED` / no approval => `exitCode: 0`
 * - successful `status` run => `exitCode: 0`
 * - `status` guard/config errors => `exitCode: 1`
 * - other command guard/config errors => `exitCode: 1`
 */
export interface CommandResult {
  exitCode: number;
  message?: string;
}
