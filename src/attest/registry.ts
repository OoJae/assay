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
