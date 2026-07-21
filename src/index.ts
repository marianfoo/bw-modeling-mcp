#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

import { createClientFromEnv } from './bw-client.js';
import { bwGetAdso } from './tools/adso.js';
import { bwGetInfoObject } from './tools/infoobject.js';
import { bwGetTransformation } from './tools/transformation.js';
import { bwGetDtps, bwGetDtp } from './tools/dtp.js';
import { bwSearch, bwXref } from './tools/search.js';
import { bwGetInfoarea } from './tools/infoarea.js';
import { bwListChangeableTransports } from './tools/cto.js';
import { bwGetInfosource } from './tools/infosource.js';
import { bwGetQuery } from './tools/query.js';
import { bwGetCompositeProvider } from './tools/composite_provider.js';
import { bwGetCkf, bwGetRkf, bwGetStructure } from './tools/cp_components.js';
import { bwListContents } from './tools/repository.js';
import { bwListSourceSystems, bwListDatasources, bwGetSourceSystem, bwGetDatasource, bwListRemoteEntities } from './tools/datasource.js';
import { bwGetDataflow } from './tools/dataflow.js';
import { bwQueryData, bwGetFilterValues, InfoObjectState, VariableInput, DrillOperation } from './tools/reporting.js';
import { bwGetRoles, bwGetQueryRoles, bwGetRoleQueries } from './tools/roles.js';
import { bwGetProcessChain } from './tools/processchain.js';
import { bwGetProcessVariant } from './tools/processvariant.js';
import { bwListRequests, bwGetRequest } from './tools/request_monitor.js';
import { bwGetOpenHub } from './tools/openhub.js';
import { bwGetAggregationLevel, bwGetPlanningProperties, bwGetPlanningSequence, bwGetPlanningFunction } from './tools/planning.js';
import { bwListProcessChainRuns, bwGetProcessChainRunDetail, bwListProcessChainLastStatus } from './tools/process_chain_monitor.js';

// Single shared client instance (CSRF token + session cookies are reused)
const client = createClientFromEnv();

const server = new Server(
  { name: 'bw-modeling-mcp', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'bw_search',
      description:
        'Universal search for BW objects by name or description. Use this whenever the user wants to find, list, or look up any BW object — aDSOs, queries (ELEM), transformations (TRFN), DTPs (DTPA), InfoObjects (IOBJ), InfoSources (TRCS), CompositeProviders (HCPR), DataSources (RSDS), InfoAreas (AREA), process chains (RSPC), and any other TLOGO type. ' +
        'Supports wildcards (e.g. "Z*" to find all objects starting with Z). ' +
        'Pass object_type to restrict results to a single type; omit it to search across all types. ' +
        'Prefer this tool over type-specific get/list tools whenever the object name is unknown or a pattern is given.',
      inputSchema: {
        type: 'object',
        properties: {
          search_term: {
            type: 'string',
            description: 'Search string. Wildcards supported: * matches any sequence, ? matches a single character. Example: "Z*" finds all objects whose name starts with Z.',
          },
          object_type: {
            type: 'string',
            description:
              'Optional TLOGO filter to restrict results to one object type. Common values: ADSO (aDSO), ELEM (BEx/BW query), TRFN (transformation), DTPA (DTP), IOBJ (InfoObject), TRCS (InfoSource), HCPR (CompositeProvider), RSDS (DataSource), AREA (InfoArea), RSPC (process chain). Leave empty to search all types.',
          },
        },
        required: ['search_term'],
      },
    },
    {
      name: 'bw_xref',
      description:
        'Find where-used / dependencies for a BW object. Returns all objects that reference the given object. ' +
        'Use this to find the Transformation and DTPs that reference an aDSO, or to find which DTPs depend on a Transformation. ' +
        'Use object_type=DTPA to find the process chain(s) a DTP belongs to — this is preferred over bw_get_dtp when only the process chain is needed.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type: ADSO, TRFN, DTPA, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Object name (e.g. "ADSO_NAME" or "TRFN_UUID_KEY").',
          },
          source_system: {
            type: 'string',
            description: 'Required for object_type "RSDS". Logical source system name (e.g. "LSYS_NAME"). The correct padded objectName is built automatically.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_adso',
      description:
        'Read an aDSO (Advanced DataStore Object) structure — fields, settings, version.',
      inputSchema: {
        type: 'object',
        properties: {
          adso_name: {
            type: 'string',
            description: 'aDSO name (e.g. "ADSO_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['adso_name'],
      },
    },
    {
      name: 'bw_list_changeable_transports',
      description:
        'List transport requests and their tasks via the BW transport state (cto/check). ' +
        'Defaults to the caller\'s modifiable requests. Use this to find an open request to assign an object to.',
      inputSchema: {
        type: 'object',
        properties: {
          own_only: {
            type: 'boolean',
            description: 'Only the caller\'s own requests (default true). false widens to all users.',
          },
          modifiable_only: {
            type: 'boolean',
            description: 'Only modifiable requests, i.e. status "D" (default true). false also returns released requests.',
          },
          include_objects: {
            type: 'boolean',
            description: 'Include the objects contained in each task (default false).',
          },
        },
      },
    },
    {
      name: 'bw_get_infoobject',
      description:
        'Read an InfoObject definition (must already exist in the system). Returns the full XML including data type, length, conversion routine, and descriptions.',
      inputSchema: {
        type: 'object',
        properties: {
          infoobject_name: {
            type: 'string',
            description: 'InfoObject name (e.g. "IOBJ_NAME").',
          },
        },
        required: ['infoobject_name'],
      },
    },
    {
      name: 'bw_get_transformation',
      description:
        'Read a Transformation structure — source/target segments, mapping rules. ' +
        'Transformation names are UUID-like generated keys (e.g. "TRFN_UUID_KEY"). ' +
        'Use bw_xref on the aDSO to find the transformation name.',
      inputSchema: {
        type: 'object',
        properties: {
          transformation_name: {
            type: 'string',
            description: 'Transformation name (UUID-like key, e.g. "TRFN_UUID_KEY").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['transformation_name'],
      },
    },
    {
      name: 'bw_get_infosource',
      description: 'Read an InfoSource (TRCS) structure — fields, key fields, label, InfoArea, version status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoSource name (e.g. "INFOSOURCE_NAME").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_infoarea',
      description: 'Read an InfoArea definition — name, label, parent area, object status.',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'InfoArea name (e.g. "NEXTJUICE").',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'bw_get_dtps',
      description:
        'List DTPs (Data Transfer Processes) that depend on a BW object. ' +
        'Uses the xref endpoint filtered to DTPA object type. ' +
        'Use object_type=TRFN and the transformation name to find DTPs after activating a transformation.',
      inputSchema: {
        type: 'object',
        properties: {
          object_type: {
            type: 'string',
            description: 'Object type of the referenced object: ADSO, TRFN, IOBJ, etc.',
          },
          object_name: {
            type: 'string',
            description: 'Object name to find dependent DTPs for.',
          },
        },
        required: ['object_type', 'object_name'],
      },
    },
    {
      name: 'bw_get_dtp',
      description:
        'Read a DTP (Data Transfer Process) definition — source, target, transformation, extraction settings, and filter fields (selections and routines). ' +
        'Use bw_xref on an aDSO to find the DTP name first. ' +
        'To find only the process chain a DTP belongs to, use bw_xref with object_type=DTPA instead — it is faster and avoids loading the full DTP definition.',
      inputSchema: {
        type: 'object',
        properties: {
          dtp_name: {
            type: 'string',
            description: 'DTP name (e.g. "DTP_...").',
          },
        },
        required: ['dtp_name'],
      },
    },
    {
      name: 'bw_get_process_chain',
      description:
        'Read a Process Chain (RSPC) definition — header metadata, scheduling and monitoring ' +
        'settings, all steps (nodes) with type, variant, and last execution status, ' +
        'step dependencies (edges) with branch conditions for DECISION nodes, ' +
        'and inline variant details. ' +
        'By default (include_variant_details=true), automatically fetches and embeds the full ' +
        'variant configuration for each step that has detail available. ' +
        'Steps without variant detail (DTP_LOAD, OR, AND, EXOR, CHAIN) are shown without extra detail — ' +
        'for DTP_LOAD use bw_get_dtp, for CHAIN use bw_get_process_chain recursively. ' +
        'Set include_variant_details=false for a faster structural overview without variant detail. ' +
        'Use bw_search with object_type=RSPC to find chain names first.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_name: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME"). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": full parsed JSON.',
          },
          include_variant_details: {
            type: 'boolean',
            description: 'If true (default), fetches variant configuration detail for each step automatically and includes it inline. Set to false to skip variant detail fetching for faster response on large chains.',
          },
        },
        required: ['chain_name'],
      },
    },
    {
      name: 'bw_get_process_variant',
      description:
        'Read the detail configuration of a single Process Variant from a Process Chain step. ' +
        'Covers all process types: ABAP (report name + selection variant), ADSOACT (aDSO activation), ' +
        'ADSOREM (request cleanup), PLSWITCHL/PLSWITCHP (planning mode switch), DTP_LOAD, ' +
        'DECISION, and any other type — oDetail is returned as indented JSON for unknown types. ' +
        'Get process_type and variant_name from bw_get_process_chain output (sProcessType and sProcessVariant fields). ' +
        'Use format="raw" to see the full unformatted JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          process_type: {
            type: 'string',
            description: 'Process type technical name from the chain step (e.g. "ABAP", "DTP_LOAD", "ADSOACT", "ADSOREM", "PLSWITCHL", "PLSWITCHP", "DECISION"). Case-insensitive.',
          },
          variant_name: {
            type: 'string',
            description: 'Process variant technical name from the chain step (e.g. "ILV_...", "DTP_...", "DEL_..."). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary with oDetail as indented JSON. "raw": full parsed JSON.',
          },
        },
        required: ['process_type', 'variant_name'],
      },
    },
    {
      name: 'bw_list_requests',
      description:
        'List the recent load requests of an InfoProvider from the runtime request monitor, ' +
        'with decoded request status, record counts and timestamps. ' +
        'Returns one entry per request including the internal request TSN, which is the ' +
        'input for bw_get_request. Read-only. ' +
        'Use bw_search to find the target technical name first. ' +
        'Performance: listing cost scales with the number of returned rows because each row ' +
        'is enriched on the backend (a per-row cross-reference read). top bounds the result set; ' +
        'created_from and status only help by returning fewer rows, not by making a row cheaper. ' +
        'For providers with long load histories, use a narrow created_from window or a small top.',
      inputSchema: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: 'Target InfoProvider technical name (e.g. "OBJECT_NAME"). Case-insensitive.',
          },
          target_type: {
            type: 'string',
            description: 'Target object type (default "ADSO").',
          },
          storage: {
            type: 'string',
            description: 'Comma-separated storage area codes (default "AQ,AX,AT").',
          },
          status: {
            type: 'string',
            description: 'Comma-separated request status codes to include (default "N,GG,GR,YG,RR,YR,RG,U,Y,X").',
          },
          created_from: {
            type: 'string',
            description:
              'Optional server-side lower time bound, ISO 8601 with milliseconds and Z ' +
              '(24 chars, e.g. "YYYY-MM-DDTHH:MM:SS.000Z"). Returns only requests created at or ' +
              'after this time (open upper bound = now). Narrows the result set, which reduces ' +
              'per-row backend enrichment cost. Recommended for providers with long load histories.',
          },
          top: {
            type: 'number',
            description:
              'Upper cap on the number of requests to return (default 3). Each returned row triggers ' +
              'an expensive per-row backend read, so keep this small; raise it only when needed.',
          },
        },
        required: ['target'],
      },
    },
    {
      name: 'bw_get_request',
      description:
        'Full status analysis of one load request in a single call, bundling the request ' +
        'header, DTP information (including start, finish and duration), the process step ' +
        'chain and the message log. Read-only. ' +
        'The request TSN comes from bw_list_requests output.',
      inputSchema: {
        type: 'object',
        properties: {
          request_tsn: {
            type: 'string',
            description: 'Internal request TSN from bw_list_requests output.',
          },
          storage: {
            type: 'string',
            description:
              'Storage area code (default "AQ"). Take it from the "Storage" line of the ' +
              'bw_list_requests output — the code differs by target type (e.g. AQ inbound, ' +
              'AT/AX active data aDSO, ATTE active text table InfoObject). A wrong code 404s ' +
              'the header/DTP/process sections, but the message log is still returned.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): readable summary. "raw": full parsed JSON of all four payloads.',
          },
        },
        required: ['request_tsn'],
      },
    },
    {
      name: 'bw_get_query',
      description:
        'Read a BW Query definition — variables, filter, layout (rows/columns/free characteristics), ' +
        'calculated and restricted measures, exceptions, and cell definitions. ' +
        'Tries the active version first; falls back to the inactive version if not found. ' +
        'format="text" (default): compact human-readable output. format="raw": full parsed JSON.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the query (e.g. "QUERY_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: '"text" (default): structured human-readable output. "raw": full parsed JSON.',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_get_composite_provider',
      description:
        'Read a CompositeProvider (HCPR) structure — general info, view node type (Union/Join), ' +
        'source providers (inputs) with mapping counts, fields with dimension classification, ' +
        'join condition, and temporal join details. Returns the inactive version.',
      inputSchema: {
        type: 'object',
        properties: {
          composite_provider_name: {
            type: 'string',
            description: 'Technical name of the CompositeProvider (e.g. "HCPR_NAME").',
          },
        },
        required: ['composite_provider_name'],
      },
    },
    {
      name: 'bw_list_contents',
      description:
        'Read the direct children of any node in the BW repository tree. ' +
        'The path parameter maps to the navigation hierarchy: ' +
        'use "/" or "" for all InfoAreas, ' +
        '"area/{name}" for InfoArea contents (object type folders), ' +
        '"area/{name}/{folder}" for objects within a folder (e.g. "area/MYAREA/adso"), ' +
        '"{type}/{name}" to expand an object (e.g. "hcpr/CP_NAME" → sub-folders), ' +
        '"{type}/{name}/{subfolder}" for objects within a sub-folder (e.g. "adso/ADSO_NAME/trfn"). ' +
        'Returns name, description, object_type, object_subtype, status, has_children, ' +
        'self_url, fiori_only, and children_path (pass directly to bw_list_contents to drill down).',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Repository path to list. Use "/" or "" for all InfoAreas. ' +
              'Examples: "area/MYAREA", "area/MYAREA/hcpr", "hcpr/CP_NAME", "hcpr/CP_NAME/elem_ckf", "adso/ADSO_NAME/trfn".',
          },
        },
        required: ['path'],
      },
    },
    {
      name: 'bw_list_source_systems',
      description:
        'List logical source systems (LSYS) registered in the BW datasource structure. ' +
        'If source_system_type is provided, lists only source systems of that type (e.g. "ODP_SAP", "ODP_BW", "FILE"). ' +
        'If omitted, lists all source systems across all types. ' +
        'Returns each LSYS with name, description, source_system_type, status, self_url, and children_path ' +
        '(pass children_path directly to bw_list_datasources as the source_system argument).',
      inputSchema: {
        type: 'object',
        properties: {
          source_system_type: {
            type: 'string',
            description:
              'Optional source system type filter. Known values: ODP_BW, ODP_SAP, ODP_CDS, ODP, FILE. ' +
              'Omit to list all source systems.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_list_datasources',
      description:
        'List all DataSources (RSDS) available under a logical source system. ' +
        'Recursively traverses the full application component (APCO) hierarchy — may take time for large systems. ' +
        'Returns each DataSource with name, source_system, description, status, self_url, and apco_path ' +
        '(ordered list of application component titles from root to the DataSource). ' +
        'Optional apco_path_filter restricts the result to a hierarchy subtree and also prunes traversal.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact plain-text table. "raw": raw XML feed bodies from BW.',
          },
          apco_path_filter: {
            type: 'string',
            description:
              'Optional APCO hierarchy filter. A contiguous sequence of APCO names, "/"-style separated by ">". ' +
              'May start at any depth in the hierarchy (not root-anchored). Example: "LEVEL_1 > LEVEL_2" returns ' +
              'every DataSource that lives under a path containing LEVEL_1 directly followed by LEVEL_2. ' +
              'Each segment matches case-insensitively against the APCO display title OR the technical APCO name (trimmed). ' +
              'A single segment like "IS-U" returns all DataSources under any APCO subtree named "IS-U", at any depth.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_source_system',
      description:
        'Read the metadata of a single logical source system (LSYS) — type, description, connection details, and maintenance properties.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). Case-insensitive.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_datasource',
      description:
        'Read the full structure of a DataSource (RSDS) — metadata, all fields with types and properties, and adapter configuration.',
      inputSchema: {
        type: 'object',
        properties: {
          datasource_name: {
            type: 'string',
            description: 'Technical name of the DataSource (e.g. "DS_NAME").',
          },
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME").',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): compact human-readable summary. "raw": raw XML from BW.',
          },
        },
        required: ['datasource_name', 'source_system'],
      },
    },
    {
      name: 'bw_list_remote_entities',
      description:
        'List the remote entities (HANA views / virtual tables) a source system exposes as a ' +
        'DataSource basis — read-only discovery (the value help Eclipse shows on the DataSource ' +
        'proposal page). Each entity\'s technical_name is exactly what binds into bw_create_datasource ' +
        'as the HANA entity. Use this to find a valid hana_entity before creating a DataSource.',
      inputSchema: {
        type: 'object',
        properties: {
          source_system: {
            type: 'string',
            description: 'Logical source system name (e.g. "LSYS_NAME"). A HANA/SDA/SDI source system.',
          },
          search_pattern: {
            type: 'string',
            description: 'Wildcard pattern filtering on technicalName (default "*" for all).',
          },
          result_size: {
            type: 'number',
            description: 'Maximum number of rows to return (default 200). Check result_complete to see if truncated.',
          },
        },
        required: ['source_system'],
      },
    },
    {
      name: 'bw_get_ckf',
      description:
        'Read a global Calculated Key Figure (CKF) defined at CompositeProvider level. ' +
        'Returns technical name, description, formula (recursively resolved), metadata, ' +
        'and the full dependency graph of referenced CKF/RKF sub-components.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the CKF (e.g. "CKF_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_rkf',
      description:
        'Read a global Restricted Key Figure (RKF) defined at CompositeProvider level. ' +
        'Returns technical name, description, base measure, characteristic filters, metadata, ' +
        'and the full dependency graph of referenced CKF/RKF sub-components.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the RKF (e.g. "RKF_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_get_structure',
      description:
        'Read a global Structure defined at CompositeProvider level. ' +
        'Returns the ordered member list with type (Selection/Formula), referenced component ' +
        'or IOBJ name, characteristic filters, and the full dependency graph.',
      inputSchema: {
        type: 'object',
        properties: {
          component_name: {
            type: 'string',
            description: 'Technical name of the Structure (e.g. "STR_NAME").',
          },
        },
        required: ['component_name'],
      },
    },
    {
      name: 'bw_query_data',
      description:
        'Execute a BW query or preview data from a provider (CompositeProvider, aDSO, etc.) via the BICS reporting endpoint. ' +
        'ALWAYS call the appropriate read tool first before querying data: ' +
        'bw_get_composite_provider for a CompositeProvider (is_provider=true), ' +
        'bw_get_adso for an aDSO (is_provider=true), ' +
        'bw_get_query for a BEx Query — this gives you the available fields, key figures, ' +
        'and the query structure before you attempt a data call. ' +
        'Then perform a GET (no state/variables) first to discover the current axis layout, ' +
        'characteristic ids, variables, and background filters before sending any POST. ' +
        'IMPORTANT — always call bw_get_filter_values before applying any filter or variable value. ' +
        'This is the only way to know the correct internal key format for a characteristic ' +
        '(e.g. date/time characteristics like 0CALMONTH, 0CALYEAR, 0CALDAY may use non-obvious formats). ' +
        'Never guess or assume filter value formats — always look them up first. ' +
        'If the GET response shows inputRequired="true", variables must be filled via POST before data is available. ' +
        'If unsure whether a BEx Query exists for the desired analysis, use bw_search or bw_list_contents first ' +
        'before falling back to a direct provider call (is_provider=true). ' +
        'Result is rendered as a formatted table with hierarchy indentation. ' +
        'KEY FIGURE STRUCTURE FILTER: to restrict which key figures appear in the result, apply filterValues ' +
        'directly on the structure dimension (isStructure=true) in state.infoObjects — use the technical name ' +
        'of the calculated or restricted key figure as the low value (e.g. "CKF_NAME" or "RKF_NAME"). ' +
        'Hierarchical children of the filtered member are included automatically. ' +
        'This is the correct approach because ad-hoc threshold filters on key figure values are not supported ' +
        'via the state mechanism; only structure-member selection is possible this way. ' +
        'CRITICAL: variable id and name values in the variablesContainer are session-specific ' +
        'and change between GET calls. Always extract variable id and name exactly from the ' +
        'variablesContainer in the GET response and use them immediately in the next POST — ' +
        'never reuse IDs from a previous GET call or from bw_get_query output. ' +
        'The variable name includes trailing spaces and a 4-digit suffix (e.g. "VARNAME                       0004") ' +
        'that must be copied verbatim from the GET response. ' +
        'format="raw" returns XML.',
      inputSchema: {
        type: 'object',
        properties: {
          comp_id: {
            type: 'string',
            description: 'BEx Query name or InfoProvider name (ADSO, HCPR, etc.) to query.',
          },
          is_provider: {
            type: 'boolean',
            description:
              'Set to true when comp_id is an InfoProvider name (CompositeProvider, aDSO, etc.) ' +
              'rather than a BEx Query name. Adds the required "!" prefix to the compid URL parameter. ' +
              'If unsure whether a query exists for the desired analysis, use bw_search or ' +
              'bw_list_contents first to check before falling back to a direct provider call.',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: '"text" (default): structured human-readable output. "raw": raw XML response body.',
          },
          state: {
            type: 'object',
            description:
              'Axis layout and optional per-characteristic filters. ' +
              'All InfoObjects from the query must be listed (even those staying on FREE axis). ' +
              'id values must come from the GET metadata response.',
            properties: {
              infoObjects: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', description: 'InfoObject technical name.' },
                    id: { type: 'string', description: 'id from the GET metadata response.' },
                    axis: { type: 'string', enum: ['ROWS', 'COLUMNS', 'FREE'], description: 'Target axis.' },
                    hierarchy: {
                      type: 'object',
                      description:
                        'Active hierarchy for this characteristic. Required when filtering by hierarchy node (nodeId=1). ' +
                        'Copy id, name, hryId, hryDateFrom, hryDateTo from the <hierarchy> element in the GET response.',
                      properties: {
                        id: { type: 'string', description: 'Hierarchy id attribute from GET response.' },
                        name: { type: 'string', description: 'Hierarchy name (technical name).' },
                        hryId: { type: 'string', description: 'hryId attribute (display name / variant).' },
                        hryDateFrom: { type: 'string', description: 'Validity from date (YYYYMMDD). Defaults to 00000000.' },
                        hryDateTo: { type: 'string', description: 'Validity to date (YYYYMMDD). Defaults to 99991231.' },
                      },
                      required: ['id', 'name', 'hryId'],
                    },
                    filterValues: {
                      type: 'array',
                      description:
                        'Optional filter selections for this characteristic. ' +
                        'Also works on structure dimensions (isStructure=true on ROWS or COLUMNS): ' +
                        'set low to the technical name of a key figure, calculated key figure, or restricted key figure ' +
                        '(e.g. "CKF_NAME") to restrict the result to that structure member and its children. ' +
                        'This is the only supported way to filter by key figure in BICS.',
                      items: {
                        type: 'object',
                        properties: {
                          low: { type: 'string', description: 'Filter value in external key format (e.g. altName or CHAVL_EXT). Use this for members that have a named external key.' },
                          lowInt: { type: 'string', description: 'Filter value in internal key format (e.g. GUID like 00O2...). Use when the member has no altName and only an internal GUID is known. Sends presentationMode="INT" in BICS XML.' },
                          lowText: { type: 'string', description: 'Display text for the value (optional).' },
                          high: { type: 'string', description: 'Upper bound for interval operator BT.' },
                          op: { type: 'string', description: 'Operator: EQ (default), BT, GT, LT, GE, LE.' },
                          sign: { type: 'string', description: 'I=include (default), E=exclude.' },
                          nodeId: { type: 'number', description: 'Node selection mode: 0=leaf member (default), 1=hierarchy node (use when filtering a collapsed hierarchy node like a group).' },
                        },
                      },
                    },
                  },
                  required: ['name', 'id', 'axis'],
                },
              },
            },
            required: ['infoObjects'],
          },
          variables: {
            type: 'array',
            description:
              'Variable values to fill. name must match exactly as returned by GET (may contain trailing spaces). ' +
              'id and other metadata fields come from the GET variablesContainer response.',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Variable technical name (exact, including trailing spaces).' },
                id: { type: 'string', description: 'Variable id from the GET response.' },
                txt: { type: 'string', description: 'Variable label (optional, for readability).' },
                altName: { type: 'string', description: 'altName from the GET response (optional).' },
                type: { type: 'string', description: 'Variable type (default "charMember").' },
                inputEnabled: { type: 'boolean', description: 'Whether the variable accepts input (default true).' },
                mandatory: { type: 'boolean', description: 'Whether the variable is mandatory.' },
                iobj: { type: 'string', description: 'InfoObject the variable is based on.' },
                values: {
                  type: 'array',
                  description: 'List of select values to assign.',
                  items: {
                    type: 'object',
                    properties: {
                      low: { type: 'string', description: 'Value (CHAVL_INT internal key format).' },
                      high: { type: 'string', description: 'Upper bound for interval (op=BT).' },
                      op: { type: 'string', description: 'Operator: EQ (default) or BT.' },
                      sign: { type: 'string', description: 'I=include (default).' },
                    },
                    required: ['low'],
                  },
                },
              },
              required: ['name', 'id', 'values'],
            },
          },
          from_row: {
            type: 'number',
            description: 'Start row for pagination (default 0).',
          },
          to_row: {
            type: 'number',
            description: 'End row for pagination (default 1000).',
          },
          drill_operations: {
            type: 'array',
            description:
              'Optional. Expand or collapse hierarchy nodes or key figure structure nodes in the current result. ' +
              'Each operation targets one node by its 1-based tuple index. ' +
              'drill_state: 3 = expand, 2 = collapse. ' +
              'element_idx: which dimension within the tuple (1 = first, 2 = second, etc.) — ' +
              'use 2 when ROWS has multiple dimensions and the target node is on the second one. ' +
              'Requires the full state and variables to be sent again in the same POST (stateless endpoint). ' +
              'Use after an initial bw_query_data call to drill into a collapsed structure node or hierarchy node.',
            items: {
              type: 'object',
              properties: {
                axis: { type: 'string', enum: ['ROWS', 'COLUMNS'] },
                drill_state: { type: 'number', description: '3 = expand, 2 = collapse.' },
                tuple_idx: { type: 'number', description: '1-based index of the tuple in the current result.' },
                element_idx: { type: 'number', description: '1-based index of the dimension within the tuple.' },
              },
              required: ['axis', 'drill_state', 'tuple_idx', 'element_idx'],
            },
          },
        },
        required: ['comp_id'],
      },
    },
    {
      name: 'bw_get_filter_values',
      description:
        'Look up valid characteristic values for use in query filters or variable inputs. ' +
        'Returns CHAVL_INT (internal key) — always use this value when setting filter selectValues or variable inputs; ' +
        'CHAVL_EXT and CHAVL_INT often differ for date-type characteristics. ' +
        'Supports wildcard search: use "*" to return all values, "2022*" for prefix match. ' +
        'Optionally scope results to a specific InfoProvider (recommended when values differ by provider).',
      inputSchema: {
        type: 'object',
        properties: {
          characteristic_name: {
            type: 'string',
            description: 'InfoObject technical name to get values for (e.g. "IOBJ_NAME").',
          },
          search_string: {
            type: 'string',
            description: 'Wildcard search pattern. "*" returns all values up to max_rows. Prefix with text to filter (e.g. "2022*").',
          },
          info_provider: {
            type: 'string',
            description: 'Optional. Scopes the value list to a specific InfoProvider (ADSO, HCPR, etc.). Omit to read from master data directly.',
          },
          max_rows: {
            type: 'number',
            description: 'Maximum number of values to return (default 201).',
          },
        },
        required: ['characteristic_name', 'search_string'],
      },
    },
    {
      name: 'bw_get_roles',
      description:
        'Load the complete BW query role hierarchy as shown in the "Publish to Role" dialog. ' +
        'Returns all roles (ROLE nodes) and their folder structure (FOLDER nodes) with nodeids. ' +
        'Use this to discover role names and folder names needed for bw_set_query_roles. ' +
        'Optionally filter to roles whose name starts with a given prefix.',
      inputSchema: {
        type: 'object',
        properties: {
          role_filter: {
            type: 'string',
            description: 'Optional prefix to filter results. Only ROLE nodes whose name starts with this prefix are included (e.g. "BW:").',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_query_roles',
      description:
        'Get all roles and folders where a specific BW query is currently published. ' +
        'Returns the role name, description, and folder for each assignment. ' +
        'If the query is not published anywhere, returns a clear message.',
      inputSchema: {
        type: 'object',
        properties: {
          query_name: {
            type: 'string',
            description: 'Technical name of the BW query (case-insensitive).',
          },
        },
        required: ['query_name'],
      },
    },
    {
      name: 'bw_get_role_queries',
      description:
        'List all BW queries published in BW roles (via the "Publish to Role" mechanism). ' +
        'Returns each role with its assigned queries, including technical name, description, object type, and InfoProvider. ' +
        'Note: only SAP_BW_QUERY objects are returned; PFCG menu entries of other types (e.g. AFO workbooks added as transactions) are not included. ' +
        'Use role_name to filter to a specific role; omit it to see all roles with published queries.',
      inputSchema: {
        type: 'object',
        properties: {
          role_name: {
            type: 'string',
            description: 'Optional. Technical name of the role to filter by (e.g. from bw_get_roles). Omit to return all roles.',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_dataflow',
      description:
        'Trace the data flow graph for a BW object. ' +
        'Returns a tree (≤ 30 nodes) or flat table (> 30 nodes) showing all connected objects ' +
        '(ADSO, RSDS, TRFN, DTPA, TRCS, IOBJ, HCPR, LSYS, ELEM) with their type, name, description, and status. ' +
        'BW direction convention: "upwards" traverses towards BW target objects (ADSO, TRFN, TRCS, IOBJ); ' +
        '"downwards" traverses towards source systems (LSYS, RSDS). ' +
        'Use this to understand the full lineage of an object without navigating each connection manually. ' +
        'IMPORTANT: Always print the complete tool result verbatim as a fenced code block in your chat response — never omit or summarize it.',
      inputSchema: {
        type: 'object',
        properties: {
          object_name: {
            type: 'string',
            description: 'Technical name of the BW object (e.g. "ADSO_NAME", "DS_NAME").',
          },
          object_type: {
            type: 'string',
            description: 'BW object type: ADSO, RSDS, HCPR, TRFN, DTPA, IOBJ, TRCS, LSYS.',
          },
          source_system: {
            type: 'string',
            description: 'Required when object_type is RSDS. Logical source system name (e.g. "LSYS_NAME").',
          },
          direction: {
            type: 'string',
            enum: ['upwards', 'downwards', 'both'],
            description: 'Direction to traverse: "upwards" (towards BW target objects: ADSO, TRFN, TRCS, IOBJ), "downwards" (towards source systems: LSYS, RSDS), or "both". Default "both".',
          },
          levels: {
            type: 'number',
            description: 'Number of levels to expand in each direction. -1 = all levels (default).',
          },
          format: {
            type: 'string',
            enum: ['text', 'raw'],
            description: 'Output format. "text" (default): tree or flat table. "raw": raw XML from BW.',
          },
        },
        required: ['object_name', 'object_type'],
      },
    },
    {
      name: 'bw_get_open_hub',
      description:
        'Read an Open Hub Destination (TLOGO DEST) definition — destination type, source, ' +
        'DB table, InfoArea, package, status, the complete output field list with type/length, ' +
        'InfoObject binding, conversion routine, compounding, and key flag, ' +
        'plus file properties when the destination type is FILE.',
      inputSchema: {
        type: 'object',
        properties: {
          open_hub_name: {
            type: 'string',
            description: 'Technical name of the Open Hub Destination (e.g. "OBJECT_NAME").',
          },
        },
        required: ['open_hub_name'],
      },
    },
    {
      name: 'bw_get_aggregation_level',
      description:
        'Read an Aggregation Level (TLOGO ALVL) definition — the planning-enabled view on top of ' +
        'an InfoProvider (aDSO or CompositeProvider) used for Integrated Planning / embedded BPC. ' +
        'Returns name, description, status, InfoArea, package, the underlying InfoProvider, ' +
        'and the full element list split into characteristics and key figures. ' +
        'Characteristics include type, length, conversion routine, base InfoObject, compounding, and dimension group. ' +
        'Key figures additionally include aggregation behavior, semantics (AMO/QUA/NUM), ' +
        'and the unit/currency reference (unit characteristic, fixed unit, or fixed currency).',
      inputSchema: {
        type: 'object',
        properties: {
          aggregation_level_name: {
            type: 'string',
            description: 'Technical name of the Aggregation Level (e.g. "OBJECT_NAME").',
          },
        },
        required: ['aggregation_level_name'],
      },
    },
    {
      name: 'bw_get_planning_function',
      description:
        'Read a Planning Function (TLOGO PLSE) definition — a planning operation ' +
        '(formula/FOX, copy, delete, repost, distribution, currency translation, custom exit, …) ' +
        'tied to an aggregation level for Integrated Planning / embedded BPC. ' +
        'Returns name, description, function type (planningServiceType), aggregation level, ' +
        'documentation, status, InfoArea, package, the characteristic usage list ' +
        '(role of each characteristic in the function), and the full parameter tree ' +
        'with nested structure and values. For FORMULA functions the FOX code surfaces ' +
        'as the value of the FLINE parameter.',
      inputSchema: {
        type: 'object',
        properties: {
          planning_function_name: {
            type: 'string',
            description: 'Technical name of the Planning Function (e.g. "OBJECT_NAME").',
          },
        },
        required: ['planning_function_name'],
      },
    },
    {
      name: 'bw_get_planning_sequence',
      description:
        'Read a Planning Sequence (TLOGO PLSQ) definition — an ordered list of planning steps ' +
        'for Integrated Planning / embedded BPC. Returns name, description, InfoArea, package, ' +
        'status, and the ordered step list. Each step shows its type code, the aggregation level, ' +
        'the planning function (planning service), and the filter name.',
      inputSchema: {
        type: 'object',
        properties: {
          planning_sequence_name: {
            type: 'string',
            description: 'Technical name of the Planning Sequence (e.g. "OBJECT_NAME").',
          },
        },
        required: ['planning_sequence_name'],
      },
    },
    {
      name: 'bw_get_planning_properties',
      description:
        'Read the Planning Properties (TLOGO PLCR) of a plan-enabled InfoProvider (real-time aDSO or ' +
        'CompositeProvider). Returns the provider name, underlying provider resource and media type, ' +
        'InfoArea, package, status, and the general planning settings: key-date mode, maximum number ' +
        'of characteristic combinations, and the save strategy (planning sequence and delta-read flag). ' +
        'The PLCR shares its technical name with the InfoProvider it belongs to.',
      inputSchema: {
        type: 'object',
        properties: {
          plan_provider_name: {
            type: 'string',
            description: 'Technical name of the plan-enabled InfoProvider (e.g. "OBJECT_NAME"). ' +
              'The PLCR object shares this name.',
          },
        },
        required: ['plan_provider_name'],
      },
    },
    {
      name: 'bw_list_process_chain_runs',
      description:
        'List execution runs of one or all process chains from the process chain monitoring log. ' +
        'Each row represents one chain run with overall status, runtime deviation, start/end timestamps, and duration. ' +
        'Optionally filter by chain technical name, start date range, and status code. ' +
        'Returns the log_id of each run — pass chain_id + log_id into bw_get_process_chain_run_detail for step-level details. ' +
        'Ordered by start time descending. Default limit 20 runs.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_name: {
            type: 'string',
            description: 'Optional process chain technical name to restrict to runs of a single chain (e.g. "CHAIN_NAME"). Omit for system-wide results.',
          },
          date_from: {
            type: 'string',
            description: 'Optional lower bound for run start date (ISO format, e.g. "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM:SS"). Maps to startDate ge datetime filter.',
          },
          date_to: {
            type: 'string',
            description: 'Optional upper bound for run start date (ISO format). Maps to startDate le datetime filter.',
          },
          status: {
            type: 'string',
            description: 'Optional status code filter (e.g. as returned by the status field of previous runs). Resolves to eq filter on the status field.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of runs to return (default 20).',
          },
        },
        required: [],
      },
    },
    {
      name: 'bw_get_process_chain_run_detail',
      description:
        'Read the execution detail of one process chain run — all process steps with type, variant, status, ' +
        'timestamps, and parent/child relationships (predecessor graph edges), plus the full message log. ' +
        'chain_id and log_id come from bw_list_process_chain_runs or bw_list_process_chain_last_status output. ' +
        'Use this to diagnose a failed run: the message log contains the actual error messages.',
      inputSchema: {
        type: 'object',
        properties: {
          chain_id: {
            type: 'string',
            description: 'Process chain technical name (e.g. "CHAIN_NAME").',
          },
          log_id: {
            type: 'string',
            description: 'Run log ID from bw_list_process_chain_runs or bw_list_process_chain_last_status (logId field).',
          },
        },
        required: ['chain_id', 'log_id'],
      },
    },
    {
      name: 'bw_list_process_chain_last_status',
      description:
        'Read the latest execution status and scheduling state for every process chain in the system — ' +
        'one row per chain. Includes last run status, runtime deviation, scheduling status, next scheduled start, ' +
        'and the log_id of the most recent run (pass into bw_get_process_chain_run_detail to drill down). ' +
        'Chains that have never run appear here too. ' +
        'Optionally filter to chains whose last run has a specific status or whose last start date falls in a range.',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            description: 'Optional filter on last run status code. Returns only chains whose most recent run matches this status.',
          },
          last_start_from: {
            type: 'string',
            description: 'Optional lower bound for last run start date (ISO format, e.g. "YYYY-MM-DD"). Maps to lastStartDate ge datetime filter.',
          },
          last_start_to: {
            type: 'string',
            description: 'Optional upper bound for last run start date (ISO format). Maps to lastStartDate le datetime filter.',
          },
          limit: {
            type: 'number',
            description: 'Optional maximum number of chains to return. Omit to return all.',
          },
        },
        required: [],
      },
    },
  ],
}));

// ── Tool handlers ─────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let text: string;

    switch (name) {
      case 'bw_search':
        text = await bwSearch(
          client,
          args?.search_term as string,
          args?.object_type as string | undefined
        );
        break;

      case 'bw_xref':
        text = await bwXref(
          client,
          args?.object_type as string,
          args?.object_name as string,
          args?.source_system as string | undefined,
        );
        break;

      case 'bw_get_adso':
        text = await bwGetAdso(
          client,
          args?.adso_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_list_changeable_transports':
        text = await bwListChangeableTransports(client, {
          ownOnly: args?.own_only as boolean ?? true,
          modifiableOnly: args?.modifiable_only as boolean ?? true,
          includeObjects: args?.include_objects as boolean ?? false,
        });
        break;

      case 'bw_get_infoobject':
        text = await bwGetInfoObject(client, args?.infoobject_name as string);
        break;

      case 'bw_get_transformation':
        text = await bwGetTransformation(
          client,
          args?.transformation_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_get_infosource':
        text = await bwGetInfosource(client, args?.name as string);
        break;

      case 'bw_get_infoarea':
        text = await bwGetInfoarea(client, args?.name as string);
        break;

      case 'bw_get_dtps':
        text = await bwGetDtps(
          client,
          args?.object_type as string,
          args?.object_name as string
        );
        break;

      case 'bw_get_dtp':
        text = await bwGetDtp(client, args?.dtp_name as string);
        break;

      case 'bw_get_process_chain':
        text = await bwGetProcessChain(
          client,
          args?.chain_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
          args?.include_variant_details !== false,
        );
        break;

      case 'bw_get_process_variant':
        text = await bwGetProcessVariant(
          client,
          args?.process_type as string,
          args?.variant_name as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_list_requests':
        text = await bwListRequests(
          client,
          args?.target as string,
          args?.target_type as string | undefined ?? 'ADSO',
          args?.storage as string | undefined ?? 'AQ,AX,AT',
          args?.status as string | undefined ?? 'N,GG,GR,YG,RR,YR,RG,U,Y,X',
          args?.top as number | undefined ?? 3,
          args?.created_from as string | undefined,
        );
        break;

      case 'bw_get_request':
        text = await bwGetRequest(
          client,
          args?.request_tsn as string,
          args?.storage as string | undefined ?? 'AQ',
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_get_query':
        text = await bwGetQuery(
          client,
          args?.query_name as string,
          (args?.format as 'text' | 'raw') ?? 'text'
        );
        break;

      case 'bw_list_contents':
        text = await bwListContents(client, args?.path as string);
        break;

      case 'bw_list_source_systems':
        text = await bwListSourceSystems(client, args?.source_system_type as string | undefined);
        break;

      case 'bw_list_datasources':
        text = await bwListDatasources(
          client,
          args?.source_system as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
          args?.apco_path_filter as string | undefined,
        );
        break;

      case 'bw_get_source_system':
        text = await bwGetSourceSystem(client, args?.source_system as string);
        break;

      case 'bw_get_datasource':
        text = await bwGetDatasource(
          client,
          args?.datasource_name as string,
          args?.source_system as string,
          args?.format as 'text' | 'raw' | undefined ?? 'text',
        );
        break;

      case 'bw_list_remote_entities':
        text = await bwListRemoteEntities(
          client,
          args?.source_system as string,
          (args?.search_pattern as string | undefined) ?? '*',
          (args?.result_size as number | undefined) ?? 200,
        );
        break;

      case 'bw_get_composite_provider':
        text = await bwGetCompositeProvider(client, args?.composite_provider_name as string);
        break;

      case 'bw_get_ckf':
        text = await bwGetCkf(client, args?.component_name as string);
        break;

      case 'bw_get_rkf':
        text = await bwGetRkf(client, args?.component_name as string);
        break;

      case 'bw_get_structure':
        text = await bwGetStructure(client, args?.component_name as string);
        break;

      case 'bw_query_data': {
        const rawState = args?.state as { infoObjects: Array<Record<string, unknown>> } | undefined;
        const state = rawState
          ? {
              infoObjects: rawState.infoObjects.map((io): InfoObjectState => ({
                name: io['name'] as string,
                id: io['id'] as string,
                axis: io['axis'] as string,
                hierarchy: io['hierarchy'] as InfoObjectState['hierarchy'],
                filterValues: io['filterValues'] as InfoObjectState['filterValues'],
              })),
            }
          : undefined;
        const rawVars = args?.variables as Array<Record<string, unknown>> | undefined;
        const variables = rawVars?.map((v): VariableInput => ({
          name: v['name'] as string,
          id: v['id'] as string,
          txt: v['txt'] as string | undefined,
          altName: v['altName'] as string | undefined,
          type: v['type'] as string | undefined,
          inputEnabled: v['inputEnabled'] as boolean | undefined,
          mandatory: v['mandatory'] as boolean | undefined,
          iobj: v['iobj'] as string | undefined,
          values: v['values'] as VariableInput['values'],
        }));
        const rawDrillOps = args?.drill_operations as Array<Record<string, unknown>> | undefined;
        const drillOperations = rawDrillOps?.map((op): DrillOperation => ({
          axis: op['axis'] as 'ROWS' | 'COLUMNS',
          drill_state: op['drill_state'] as 3 | 2,
          tuple_idx: op['tuple_idx'] as number,
          element_idx: op['element_idx'] as number,
        }));
        text = await bwQueryData(
          client,
          args?.comp_id as string,
          (args?.is_provider as boolean) ?? false,
          (args?.format as 'text' | 'raw') ?? 'text',
          state,
          variables,
          (args?.from_row as number) ?? 0,
          (args?.to_row as number) ?? 1000,
          drillOperations
        );
        break;
      }

      case 'bw_get_filter_values':
        text = await bwGetFilterValues(
          client,
          args?.characteristic_name as string,
          args?.search_string as string,
          args?.info_provider as string | undefined,
          (args?.max_rows as number) ?? 201
        );
        break;

      case 'bw_get_roles':
        text = await bwGetRoles(
          client,
          args?.role_filter as string | undefined
        );
        break;

      case 'bw_get_query_roles':
        text = await bwGetQueryRoles(
          client,
          args?.query_name as string
        );
        break;

      case 'bw_get_role_queries':
        text = await bwGetRoleQueries(
          client,
          args?.role_name as string | undefined
        );
        break;

      case 'bw_get_dataflow':
        text = await bwGetDataflow(
          client,
          args?.object_name as string,
          args?.object_type as string,
          args?.source_system as string | undefined,
          (args?.direction as 'upwards' | 'downwards' | 'both') ?? 'both',
          (args?.levels as number) ?? -1,
          (args?.format as 'text' | 'raw') ?? 'text',
        );
        break;

      case 'bw_get_open_hub':
        text = await bwGetOpenHub(client, args?.open_hub_name as string);
        break;

      case 'bw_get_aggregation_level':
        text = await bwGetAggregationLevel(client, args?.aggregation_level_name as string);
        break;

      case 'bw_get_planning_function':
        text = await bwGetPlanningFunction(client, args?.planning_function_name as string);
        break;

      case 'bw_get_planning_sequence':
        text = await bwGetPlanningSequence(client, args?.planning_sequence_name as string);
        break;

      case 'bw_get_planning_properties':
        text = await bwGetPlanningProperties(client, args?.plan_provider_name as string);
        break;

      case 'bw_list_process_chain_runs':
        text = await bwListProcessChainRuns(
          client,
          args?.chain_name as string | undefined,
          args?.date_from as string | undefined,
          args?.date_to as string | undefined,
          args?.status as string | undefined,
          (args?.limit as number | undefined) ?? 20,
        );
        break;

      case 'bw_get_process_chain_run_detail':
        text = await bwGetProcessChainRunDetail(
          client,
          args?.chain_id as string,
          args?.log_id as string,
        );
        break;

      case 'bw_list_process_chain_last_status':
        text = await bwListProcessChainLastStatus(
          client,
          args?.status as string | undefined,
          args?.last_start_from as string | undefined,
          args?.last_start_to as string | undefined,
          args?.limit as number | undefined,
        );
        break;

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }

    return { content: [{ type: 'text', text }] };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // Return as error content so Claude can see the details
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    await client.loadMediaTypes();
  } catch (err) {
    process.stderr.write(`[bw-modeling-mcp] Warning: discovery failed, using hardcoded media type fallbacks (${err})\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Log to stderr only (stdout is used for MCP protocol messages)
  process.stderr.write('bw-modeling-mcp server started\n');
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err}\n`);
  process.exit(1);
});
