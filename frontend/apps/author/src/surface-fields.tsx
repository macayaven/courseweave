import type { AuthorSurface, AuthorNotebookSelector } from "@courseweave/ui";
import { createSurfaceStart, type DraftSurface } from "./draft";
import { TextField, SelectField, ArrayFields } from "./field-inputs";
import { surfaceTypes, surfacePurposes, selectorTypes, selectorMatches } from "./schema-options";
export function SurfaceFields({
  surface,
  update,
  replace,
  pointer,
}: {
  surface: DraftSurface;
  update(patch: Record<string, unknown>): void;
  replace(surface: AuthorSurface): void;
  pointer: string;
}) {
  const p = (field: string) => `${pointer}/${field}`;
  return (
    <>
      <TextField
        label="Surface ID"
        pointer={p("id")}
        value={surface.id}
        onChange={(id) => update({ id })}
      />
      <TextField
        label={surface.type === "terminal" ? "Terminal label" : "Surface label"}
        pointer={p("label")}
        value={surface.label}
        onChange={(label) => update({ label })}
      />
      <SelectField
        label="Surface type"
        pointer={p("type")}
        value={surface.type}
        options={surfaceTypes}
        onChange={(type) =>
          replace({
            ...createSurfaceStart(type),
            id: surface.id,
            purpose: surface.purpose,
            label: surface.label,
          })
        }
      />
      <SelectField
        label="Surface purpose"
        pointer={p("purpose")}
        value={surface.purpose}
        options={surfacePurposes}
        onChange={(purpose) => update({ purpose })}
      />
      {"path" in surface ? (
        <TextField
          label="Path"
          pointer={p("path")}
          value={surface.path}
          onChange={(path) => update({ path })}
        />
      ) : null}
      {surface.type === "html" ? (
        <TextField
          label="HTML fragment"
          pointer={p("fragment")}
          value={surface.fragment}
          onChange={(fragment) => update({ fragment: fragment || undefined })}
        />
      ) : null}
      {surface.type === "notebook" ? (
        <>
          <SelectField
            label="Notebook selector"
            pointer={p("selector/type")}
            value={surface.selector.type}
            options={selectorTypes}
            onChange={(type) => {
              const selector: AuthorNotebookSelector =
                type === "whole_notebook"
                  ? { type }
                  : type === "cell_ids"
                    ? { type, values: ["cell"] }
                    : { type, values: ["tag"], match: "any" };
              update({ selector });
            }}
          />
          {surface.selector.type !== "whole_notebook" ? (
            <ArrayFields
              label={
                surface.selector.type === "cell_ids" ? "Cell IDs" : "Cell tags"
              }
              itemLabel={
                surface.selector.type === "cell_ids" ? "Cell ID" : "Cell tag"
              }
              values={surface.selector.values}
              pointer={p("selector/values")}
              onChange={(values) =>
                update({ selector: { ...surface.selector, values } })
              }
            />
          ) : null}
          {surface.selector.type === "cell_tags" ? (
            <SelectField
              label="Tag matching"
              pointer={p("selector/match")}
              value={surface.selector.match}
              options={selectorMatches}
              onChange={(match) =>
                update({ selector: { ...surface.selector, match } })
              }
            />
          ) : null}
        </>
      ) : null}
      {surface.type === "terminal" ? (
        <>
          <ArrayFields
            label="Arguments"
            itemLabel="Argument"
            values={surface.command}
            pointer={p("command")}
            onChange={(command) => update({ command })}
          />
          <TextField
            label="Working directory"
            pointer={p("cwd")}
            value={surface.cwd}
            onChange={(cwd) => update({ cwd })}
          />
        </>
      ) : null}
      {surface.type === "external" ? (
        <TextField
          label="External URL"
          pointer={p("url")}
          value={surface.url}
          onChange={(url) => update({ url })}
        />
      ) : null}
      {surface.type === "video" ? (
        <>
          <TextField
            label="Video source"
            pointer={p("src")}
            value={surface.src}
            onChange={(src) => update({ src })}
          />
          {(["start_seconds", "end_seconds"] as const).map((field) => (
            <TextField
              key={field}
              label={
                field === "start_seconds" ? "Start seconds" : "End seconds"
              }
              pointer={p(field)}
              type="number"
              value={surface[field]}
              onChange={(value) =>
                update({ [field]: value === "" ? undefined : Number(value) })
              }
            />
          ))}
        </>
      ) : null}
    </>
  );
}
