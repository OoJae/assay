/**
 * ERC-8004 ValidationRegistry ABI, taken verbatim from the canonical contracts repo
 * (erc-8004/erc-8004-contracts/abis/ValidationRegistry.json) rather than hand-written.
 *
 * NOT shipped in @openserv-labs/client, which ships only Identity and Reputation — so this
 * address and ABI are ours to carry.
 *
 * Verified live on Base 8453:
 *   ValidationRegistry 0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58  getVersion() "2.0.0"
 *   getIdentityRegistry() -> 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432  (where agent 95265 lives)
 */
export const VALIDATION_REGISTRY = '0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58' as const
export const IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432' as const

/** data/erc8004.json: the canonical identity, and the record of every other one that exists. */
export interface Erc8004State {
  agentId: string
  agentURI: string
  owner: string
  txHash: string
  chainId: number
  duplicates?: string[]
  note?: string
  frozen?: Array<{ agentId: string; owner: string; reason: string }>
  /** Every earlier canonical record, verbatim, including its note. Appended, never edited. */
  history?: Array<{ agentId: string; owner: string; txHash: string; note?: string }>
}

/**
 * The identity record after minting `minted`, given the record before it. Pure.
 *
 * A forced re-mint APPENDS; it never erases. The version inside mint-8004.ts wrote `frozen` only
 * when the owner changed and never read the previous one, so a same-wallet --force would have
 * dropped the disclosure that 95265 is frozen, and it reused the previous note verbatim — which
 * reads "95374 is canonical" — beside a new canonical id. The note is now generated from the
 * structured fields, and every earlier note is kept in `history` rather than overwritten.
 *
 * A previous identity under a DIFFERENT owner is frozen, not a duplicate: those are different
 * claims. Only same-owner re-mints are duplicates. `frozenReason` is required for an owner change
 * because only the operator knows why the old key is no longer used.
 */
export function mergeIdentityState(
  previous: Erc8004State | null,
  minted: { agentId: string; agentURI: string; owner: string; txHash: string },
  frozenReason?: string,
): Erc8004State {
  if (!previous) {
    return { agentId: minted.agentId, agentURI: minted.agentURI, owner: minted.owner, txHash: minted.txHash, chainId: 8453 }
  }
  const ownerChanged = previous.owner.toLowerCase() !== minted.owner.toLowerCase()
  if (ownerChanged && !frozenReason) {
    throw new Error(`the owner changed from ${previous.owner}: say why ${previous.agentId} is frozen (--frozen-reason)`)
  }
  const frozen = [
    ...(previous.frozen ?? []),
    ...(ownerChanged ? [{ agentId: previous.agentId, owner: previous.owner, reason: frozenReason! }] : []),
  ].filter((f) => f.agentId !== minted.agentId)
  const duplicates = [...(previous.duplicates ?? []), ...(ownerChanged ? [] : [previous.agentId])].filter(
    (id, i, all) => id !== minted.agentId && all.indexOf(id) === i,
  )
  const note =
    `${minted.agentId} is canonical, owned by ${minted.owner}. ` +
    frozen.map((f) => `${f.agentId} (owner ${f.owner}) is FROZEN: ${f.reason}. `).join('') +
    (duplicates.length
      ? `${duplicates.join(', ')} ${duplicates.length > 1 ? 'are' : 'is'} an accidental duplicate, not canonical. `
      : '') +
    'Recorded rather than hidden.'
  return {
    agentId: minted.agentId,
    agentURI: minted.agentURI,
    owner: minted.owner,
    txHash: minted.txHash,
    chainId: previous.chainId ?? 8453,
    ...(duplicates.length ? { duplicates } : {}),
    ...(frozen.length ? { frozen } : {}),
    note,
    history: [
      ...(previous.history ?? []),
      { agentId: previous.agentId, owner: previous.owner, txHash: previous.txHash, ...(previous.note ? { note: previous.note } : {}) },
    ],
  }
}

export const validationRegistryAbi = [
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "validatorAddress",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "requestURI",
        "type": "string"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "requestHash",
        "type": "bytes32"
      }
    ],
    "name": "ValidationRequest",
    "type": "event"
  },
  {
    "anonymous": false,
    "inputs": [
      {
        "indexed": true,
        "internalType": "address",
        "name": "validatorAddress",
        "type": "address"
      },
      {
        "indexed": true,
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "indexed": true,
        "internalType": "bytes32",
        "name": "requestHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "uint8",
        "name": "response",
        "type": "uint8"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "responseURI",
        "type": "string"
      },
      {
        "indexed": false,
        "internalType": "bytes32",
        "name": "responseHash",
        "type": "bytes32"
      },
      {
        "indexed": false,
        "internalType": "string",
        "name": "tag",
        "type": "string"
      }
    ],
    "name": "ValidationResponse",
    "type": "event"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      }
    ],
    "name": "getAgentValidations",
    "outputs": [
      {
        "internalType": "bytes32[]",
        "name": "",
        "type": "bytes32[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [],
    "name": "getIdentityRegistry",
    "outputs": [
      {
        "internalType": "address",
        "name": "",
        "type": "address"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "internalType": "address[]",
        "name": "validatorAddresses",
        "type": "address[]"
      },
      {
        "internalType": "string",
        "name": "tag",
        "type": "string"
      }
    ],
    "name": "getSummary",
    "outputs": [
      {
        "internalType": "uint64",
        "name": "count",
        "type": "uint64"
      },
      {
        "internalType": "uint8",
        "name": "avgResponse",
        "type": "uint8"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "requestHash",
        "type": "bytes32"
      }
    ],
    "name": "getValidationStatus",
    "outputs": [
      {
        "internalType": "address",
        "name": "validatorAddress",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "internalType": "uint8",
        "name": "response",
        "type": "uint8"
      },
      {
        "internalType": "bytes32",
        "name": "responseHash",
        "type": "bytes32"
      },
      {
        "internalType": "string",
        "name": "tag",
        "type": "string"
      },
      {
        "internalType": "uint256",
        "name": "lastUpdate",
        "type": "uint256"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "validatorAddress",
        "type": "address"
      }
    ],
    "name": "getValidatorRequests",
    "outputs": [
      {
        "internalType": "bytes32[]",
        "name": "",
        "type": "bytes32[]"
      }
    ],
    "stateMutability": "view",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "address",
        "name": "validatorAddress",
        "type": "address"
      },
      {
        "internalType": "uint256",
        "name": "agentId",
        "type": "uint256"
      },
      {
        "internalType": "string",
        "name": "requestURI",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "requestHash",
        "type": "bytes32"
      }
    ],
    "name": "validationRequest",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  },
  {
    "inputs": [
      {
        "internalType": "bytes32",
        "name": "requestHash",
        "type": "bytes32"
      },
      {
        "internalType": "uint8",
        "name": "response",
        "type": "uint8"
      },
      {
        "internalType": "string",
        "name": "responseURI",
        "type": "string"
      },
      {
        "internalType": "bytes32",
        "name": "responseHash",
        "type": "bytes32"
      },
      {
        "internalType": "string",
        "name": "tag",
        "type": "string"
      }
    ],
    "name": "validationResponse",
    "outputs": [],
    "stateMutability": "nonpayable",
    "type": "function"
  }
] as const
