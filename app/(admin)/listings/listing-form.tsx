"use client";

import {
  Checkbox,
  CheckboxContent,
  CheckboxControl,
  CheckboxIndicator,
  Description,
  FieldError,
  Input,
  Label,
  TextArea,
  TextField,
} from "@heroui/react";
import { ActionForm, SubmitButton, type ActionState } from "@/components/action-form";

export interface ListingFormValues {
  listingId?: number;
  listingType: "sale" | "charter";
  name?: string | null;
  summary?: string | null;
  condition?: string | null;
  builder?: string | null;
  model?: string | null;
  yearBuilt?: number | null;
  loaM?: number | null;
  hin?: string | null;
  imo?: string | null;
  powerOrSail?: string | null;
  category?: string | null;
  beamM?: number | null;
  cabins?: number | null;
  sleeps?: number | null;
  priceAmount?: string | null;
  priceCurrency?: string | null;
  priceOnApplication?: boolean;
  locationDisplay?: string | null;
  locationCity?: string | null;
  locationCountry?: string | null;
  locationMarina?: string | null;
  overview?: string | null;
  brokerName?: string | null;
  brokerEmail?: string | null;
  brokerPhone?: string | null;
  summerBasePort?: string | null;
  winterBasePort?: string | null;
  rateMin?: string | null;
  rateMax?: string | null;
  rateCurrency?: string | null;
}

interface Props {
  action: (previous: ActionState, form: FormData) => Promise<ActionState>;
  values: ListingFormValues;
  builders: { slug: string; name: string }[];
  categories: { slug: string; name: string }[];
  /** On a new listing: vessels that already exist, for a vessel that is both for sale and for charter. */
  vessels?: { id: number; label: string }[];
  submitLabel: string;
}

const str = (value: string | number | null | undefined) => (value === null || value === undefined ? "" : String(value));
const nativeField = "border-border bg-field text-foreground mt-1 w-full rounded-xl border px-3 py-2 text-sm shadow-sm";

function Field({
  name,
  label,
  help,
  defaultValue,
  type = "text",
  required = false,
}: {
  name: string;
  label: string;
  help?: string;
  defaultValue?: string | number | null;
  type?: string;
  required?: boolean;
}) {
  return (
    <TextField name={name} type={type} isRequired={required} defaultValue={str(defaultValue)}>
      <Label>{label}</Label>
      <Input />
      {help && <Description>{help}</Description>}
      <FieldError />
    </TextField>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <fieldset className="border-border flex flex-col gap-4 border-t pt-5">
    <legend className="pr-3 text-sm font-semibold">{title}</legend>
    {children}
  </fieldset>
);

export function ListingForm({ action, values, builders, categories, vessels, submitLabel }: Props) {
  const charter = values.listingType === "charter";
  return (
    <ActionForm action={action} className="flex flex-col gap-6">
      {values.listingId !== undefined && <input type="hidden" name="listing_id" value={values.listingId} />}
      <input type="hidden" name="listing_type" value={values.listingType} />

      <Section title="Listing">
        <Field name="name" label="Name" required defaultValue={values.name} help="The vessel's current marketing name." />
        <Field name="summary" label="Summary" defaultValue={values.summary} help="A plain-text teaser. No markup." />
        <label className="text-sm font-medium">
          Condition
          <select name="condition" defaultValue={str(values.condition)} className={nativeField}>
            <option value="">Not stated</option>
            <option value="new">New</option>
            <option value="used">Used</option>
          </select>
        </label>
      </Section>

      <Section title="Vessel">
        {vessels !== undefined && vessels.length > 0 && (
          <label className="text-sm font-medium">
            Vessel
            <select name="vessel_id" defaultValue="" className={nativeField}>
              <option value="">A new vessel — described below</option>
              {vessels.map((vessel) => (
                <option key={vessel.id} value={vessel.id}>
                  {vessel.label}
                </option>
              ))}
            </select>
            <span className="text-muted mt-1 block text-xs font-normal">
              A vessel that is both for sale and for charter is one vessel with two listings. Choosing one here ignores the vessel fields below.
            </span>
          </label>
        )}
        <label className="text-sm font-medium">
          Builder
          <input name="builder" list="builder-registry" defaultValue={str(values.builder)} autoComplete="off" className={nativeField} />
          <datalist id="builder-registry">
            {builders.map((builder) => (
              <option key={builder.slug} value={builder.name} />
            ))}
          </datalist>
          <span className="text-muted mt-1 block text-xs font-normal">
            Pick from the shared builder registry where you can. A builder that is not in it is saved as unlisted — it is never given a made-up
            identifier.
          </span>
        </label>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="model" label="Model" defaultValue={values.model} />
          <Field name="year_built" label="Year built" defaultValue={values.yearBuilt} />
          <Field name="loa_m" label="Length overall (m)" defaultValue={values.loaM} help="Metres. Partners convert for display." />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field name="hin" label="Hull identification number" defaultValue={values.hin} />
          <Field name="imo" label="IMO number" defaultValue={values.imo} />
        </div>
        <p className="text-muted text-xs">
          HIN and IMO are how other nodes recognise the same physical vessel. They are shared only with partners granted vessel identifiers.
        </p>
      </Section>

      <Section title="Specifications">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Power or sail
            <select name="power_or_sail" defaultValue={values.powerOrSail ?? "power"} className={nativeField}>
              <option value="power">Power</option>
              <option value="sail">Sail</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Category
            <select name="category" defaultValue={str(values.category)} className={nativeField}>
              <option value="">None</option>
              {categories.map((category) => (
                <option key={category.slug} value={category.slug}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="beam_m" label="Beam (m)" defaultValue={values.beamM} />
          <Field name="cabins" label="Cabins" defaultValue={values.cabins} />
          <Field name="sleeps" label="Sleeps" defaultValue={values.sleeps} />
        </div>
      </Section>

      {charter ? (
        <Section title="Charter">
          <p className="text-muted text-xs">A charter listing has no sale price: its pricing is its rates.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field name="rate_min" label="Weekly rate from" defaultValue={values.rateMin} help="Digits only." />
            <Field name="rate_max" label="Weekly rate to" defaultValue={values.rateMax} />
            <Field name="rate_currency" label="Currency" defaultValue={values.rateCurrency} help="ISO 4217, such as EUR." />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field name="summer_base_port" label="Summer base port" defaultValue={values.summerBasePort} />
            <Field name="winter_base_port" label="Winter base port" defaultValue={values.winterBasePort} />
          </div>
        </Section>
      ) : (
        <Section title="Price">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              name="price_amount"
              label="Asking price"
              defaultValue={values.priceAmount}
              help="Digits only — 1250000 or 1250000.50. One currency; partners convert with their own rates."
            />
            <Field name="price_currency" label="Currency" defaultValue={values.priceCurrency} help="ISO 4217, such as EUR." />
          </div>
          <Checkbox name="price_on_application" value="yes" defaultSelected={values.priceOnApplication ?? false}>
            <CheckboxContent>
              <CheckboxControl>
                <CheckboxIndicator />
              </CheckboxControl>
              <Label>Price on application</Label>
            </CheckboxContent>
            <Description>The amount is kept here and never sent to any partner.</Description>
          </Checkbox>
        </Section>
      )}

      <Section title="Location">
        <Field
          name="location_display"
          label="Public wording"
          defaultValue={values.locationDisplay}
          help="What partners display, such as “Palma de Mallorca, Spain”."
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="location_city" label="City" defaultValue={values.locationCity} />
          <Field name="location_country" label="Country" defaultValue={values.locationCountry} help="Two letters, such as ES." />
          <Field
            name="location_marina"
            label="Marina or berth"
            defaultValue={values.locationMarina}
            help="Only for partners granted exact location."
          />
        </div>
      </Section>

      <Section title="Description">
        <TextField name="overview" defaultValue={str(values.overview)}>
          <Label>Overview</Label>
          <TextArea rows={6} />
          <Description>Simple HTML: paragraphs, lists, bold, italic, h3/h4 and https links. Anything else is removed when you save.</Description>
        </TextField>
      </Section>

      <Section title="Lead broker">
        <div className="grid gap-4 sm:grid-cols-3">
          <Field name="broker_name" label="Name" defaultValue={values.brokerName} />
          <Field name="broker_email" label="Email" type="email" defaultValue={values.brokerEmail} />
          <Field name="broker_phone" label="Phone" defaultValue={values.brokerPhone} />
        </div>
      </Section>

      <SubmitButton variant="primary" className="self-start">
        {submitLabel}
      </SubmitButton>
    </ActionForm>
  );
}
