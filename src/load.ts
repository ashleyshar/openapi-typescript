import fetch from "node-fetch";
import fs from "fs";
import path from "path";
import { URL } from "url";
import slash from "slash";
import mime from "mime";
import yaml from "js-yaml";
import { red } from "kleur";
import { GlobalContext, Headers } from "./types";
import { parseRef } from "./utils";

type PartialSchema = Record<string, any>; // not a very accurate type, but this is easier to deal with before we know we’re dealing with a valid spec
type SchemaMap = { [url: string]: PartialSchema };

export const VIRTUAL_JSON_URL = `file:///_json`; // fake URL reserved for dynamic JSON

function parseSchema(schema: any, type: "YAML" | "JSON") {
  if (type === "YAML") {
    try {
      return yaml.load(schema);
    } catch (err: any) {
      throw new Error(`YAML: ${err.toString()}`);
    }
  } else {
    try {
      return JSON.parse(schema);
    } catch (err: any) {
      throw new Error(`JSON: ${err.toString()}`);
    }
  }
}

function isFile(url: URL): boolean {
  return url.protocol === "file:";
}

export function resolveSchema(url: string): URL {
  // option 1: remote
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return new URL(url);
  }

  // option 2: local
  const localPath = path.isAbsolute(url)
    ? new URL("", `file://${slash(url)}`)
    : new URL(url, `file://${slash(process.cwd())}/`); // if absolute path is provided use that; otherwise search cwd\

  if (!fs.existsSync(localPath)) {
    throw new Error(`Could not locate ${url}`);
  } else if (fs.statSync(localPath).isDirectory()) {
    throw new Error(`${localPath} is a directory not a file`);
  }

  return localPath;
}

/**
 * Accepts income HTTP headers and appends them to
 * the fetch request for the schema.
 *
 * @param {HTTPHeaderMap} httpHeaders
 * @return {Record<string, string>}  {Record<string, string>} Final HTTP headers outcome.
 */
function parseHttpHeaders(httpHeaders: Record<string, any>): Headers {
  const finalHeaders: Record<string, string> = {};

  // Obtain the header key
  for (const [k, v] of Object.entries(httpHeaders)) {
    // If the value of the header is already a string, we can move on, otherwise we have to parse it
    if (typeof v === "string") {
      finalHeaders[k] = v;
    } else {
      try {
        const stringVal = JSON.stringify(v);
        finalHeaders[k] = stringVal;
      } catch (err) {
        /* istanbul ignore next */
        console.error(
          red(`Cannot parse key: ${k} into JSON format. Continuing with the next HTTP header that is specified`)
        );
      }
    }
  }

  return finalHeaders;
}

interface LoadOptions extends GlobalContext {
  rootURL: URL;
  schemas: SchemaMap;
  urlCache?: Set<string>; // URL cache (prevent URLs from being loaded over and over)
  httpHeaders?: Headers;
  httpMethod?: string;
}

/** Load a schema from local path or remote URL */
export default async function load(
  schema: URL | PartialSchema,
  options: LoadOptions
): Promise<{ [url: string]: PartialSchema }> {
  const urlCache = options.urlCache || new Set<string>();

  const isJSON = schema instanceof URL === false; // if this is dynamically-passed-in JSON, we’ll have to change a few things
  let schemaID = isJSON ? new URL(VIRTUAL_JSON_URL).href : (schema.href as string);

  const schemas = options.schemas;

  // scenario 1: load schema from dynamic JSON
  if (isJSON) {
    schemas[schemaID] = schema;
  }
  // scenario 2: fetch schema from URL (local or remote)
  else {
    if (urlCache.has(schemaID)) return options.schemas; // exit early if this has already been scanned
    urlCache.add(schemaID); // add URL to cache

    let contents = "";
    let contentType = "";
    const schemaURL = schema as URL; // helps TypeScript

    if (isFile(schemaURL)) {
      // load local
      contents = await fs.promises.readFile(schemaURL, "utf8");
      contentType = mime.getType(schemaID) || "";
    } else {
      // load remote
      const headers: Headers = {
        "User-Agent": "openapi-typescript",
      };
      if (options.auth) headers.Authorizaton = options.auth;

      // Add custom parsed HTTP headers
      if (options.httpHeaders) {
        const parsedHeaders = parseHttpHeaders(options.httpHeaders);
        for (const [k, v] of Object.entries(parsedHeaders)) {
          headers[k] = v;
        }
      }

      const res = await fetch(schemaID, { method: options.httpMethod || "GET", headers });
      contentType = res.headers.get("Content-Type") || "";
      contents = await res.text();
    }

    const isYAML = contentType === "application/openapi+yaml" || contentType === "text/yaml";
    const isJSON =
      contentType === "application/json" ||
      contentType === "application/json5" ||
      contentType === "application/openapi+json";
    if (isYAML) {
      schemas[schemaID] = parseSchema(contents, "YAML");
    } else if (isJSON) {
      schemas[schemaID] = parseSchema(contents, "JSON");
    } else {
      // if contentType is unknown, guess
      try {
        schemas[schemaID] = parseSchema(contents, "JSON");
      } catch (err1) {
        try {
          schemas[schemaID] = parseSchema(contents, "YAML");
        } catch (err2) {
          throw new Error(`Unknown format${contentType ? `: "${contentType}"` : ""}. Only YAML or JSON supported.`); // give up: unknown type
        }
      }
    }
  }

  // scan $refs, but don’t transform (load everything in parallel)
  const refPromises: Promise<any>[] = [];
  schemas[schemaID] = JSON.parse(JSON.stringify(schemas[schemaID]), (k, v) => {
    if (k !== "$ref" || typeof v !== "string") return v;

    const { url: refURL } = parseRef(v);
    if (refURL) {
      // load $refs (only if new) and merge subschemas with top-level schema
      const isRemoteURL = refURL.startsWith("http://") || refURL.startsWith("https://");

      // if this is dynamic JSON, we have no idea how to resolve relative URLs, so throw here
      if (isJSON && !isRemoteURL) {
        throw new Error(`Can’t load URL "${refURL}" from dynamic JSON. Load this schema from a URL instead.`);
      }

      const nextURL = isRemoteURL ? new URL(refURL) : new URL(slash(refURL), schema as URL);
      refPromises.push(
        load(nextURL, { ...options, urlCache }).then((subschemas) => {
          for (const subschemaURL of Object.keys(subschemas)) {
            schemas[subschemaURL] = subschemas[subschemaURL];
          }
        })
      );
      return v.replace(refURL, nextURL.href); // resolve relative URLs to absolute URLs so the schema can be flattened
    }
    return v;
  });
  await Promise.all(refPromises);

  // transform $refs once, at the root schema, after all have been scanned & downloaded (much easier to do here when we have the context)
  if (schemaID === options.rootURL.href) {
    for (const subschemaURL of Object.keys(schemas)) {
      // transform $refs in schema
      schemas[subschemaURL] = JSON.parse(JSON.stringify(schemas[subschemaURL]), (k, v) => {
        if (k !== "$ref" || typeof v !== "string") return v;
        if (!v.includes("#")) return v; // already transformed; skip

        const { url, parts } = parseRef(v);
        // scenario 1: resolve all external URLs so long as they don’t point back to root schema
        if (url && new URL(url).href !== options.rootURL.href) {
          const relativeURL =
            isFile(new URL(url)) && isFile(options.rootURL)
              ? path.posix.relative(path.posix.dirname(options.rootURL.href), url)
              : url;
          return `external["${relativeURL}"]["${parts.join('"]["')}"]`; // export external ref
        }
        // scenario 2: treat all $refs in external schemas as external
        if (!url && subschemaURL !== options.rootURL.href) {
          const relativeURL =
            isFile(new URL(subschemaURL)) && isFile(options.rootURL)
              ? path.posix.relative(path.posix.dirname(options.rootURL.href), subschemaURL)
              : subschemaURL;
          return `external["${relativeURL}"]["${parts.join('"]["')}"]`; // export external ref
        }

        // References to properties of schemas like `#/components/schemas/Pet/properties/name`
        // requires the components to be wrapped in a `properties` object. But to keep
        // backwards compatibility we should instead just remove the `properties` part.
        // For us to recognize the `properties` part it simply has to be the second last.
        if (parts[parts.length - 2] === "properties") {
          parts.splice(parts.length - 2, 1);
        }

        // scenario 3: transform all $refs pointing back to root schema
        const [base, ...rest] = parts;

        return `${base}["${rest.join('"]["')}"]`; // transform other $refs to the root schema (including external refs that point back to the root schema)
      });

      // use relative keys for external schemas (schemas generated on different machines should have the same namespace)
      if (subschemaURL !== options.rootURL.href) {
        const relativeURL =
          isFile(new URL(subschemaURL)) && isFile(options.rootURL)
            ? path.posix.relative(path.posix.dirname(options.rootURL.href), subschemaURL)
            : subschemaURL;
        if (relativeURL !== subschemaURL) {
          schemas[relativeURL] = schemas[subschemaURL];
          delete schemas[subschemaURL];
        }
      }
    }
  }

  return schemas;
}
