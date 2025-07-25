import type {
  ActiveVisit,
  Errors,
  FormDataConvertible,
  FormDataKeys,
  Method,
  Page,
  PendingVisit,
  Progress,
  RequestPayload,
  VisitOptions,
} from '@inertiajs/core'
import { router } from '@inertiajs/core'
import type { AxiosProgressEvent } from 'axios'
import { cloneDeep, isEqual } from 'es-toolkit'
import { get, has, set } from 'es-toolkit/compat'
import { writable, type Writable } from 'svelte/store'

type FormDataType = Record<string, FormDataConvertible>
type FormOptions = Omit<VisitOptions, 'data'>

export interface InertiaFormProps<TForm extends FormDataType> {
  isDirty: boolean
  errors: Partial<Record<FormDataKeys<TForm>, string>>
  hasErrors: boolean
  progress: Progress | null
  wasSuccessful: boolean
  recentlySuccessful: boolean
  processing: boolean
  setStore(data: TForm): void
  setStore(key: FormDataKeys<TForm>, value?: FormDataConvertible): void
  data(): TForm
  transform(callback: (data: TForm) => object): this
  defaults(): this
  defaults(fields: Partial<TForm>): this
  defaults(field?: FormDataKeys<TForm>, value?: FormDataConvertible): this
  reset(...fields: FormDataKeys<TForm>[]): this
  clearErrors(...fields: FormDataKeys<TForm>[]): this
  resetAndClearErrors(...fields: FormDataKeys<TForm>[]): this
  setError(field: FormDataKeys<TForm>, value: string): this
  setError(errors: Errors): this
  submit: (...args: [Method, string, FormOptions?] | [{ url: string; method: Method }, FormOptions?]) => void
  get(url: string, options?: FormOptions): void
  post(url: string, options?: FormOptions): void
  put(url: string, options?: FormOptions): void
  patch(url: string, options?: FormOptions): void
  delete(url: string, options?: FormOptions): void
  cancel(): void
}

export type InertiaForm<TForm extends FormDataType> = InertiaFormProps<TForm> & TForm

export default function useForm<TForm extends FormDataType>(data: TForm | (() => TForm)): Writable<InertiaForm<TForm>>
export default function useForm<TForm extends FormDataType>(
  rememberKey: string,
  data: TForm | (() => TForm),
): Writable<InertiaForm<TForm>>
export default function useForm<TForm extends FormDataType>(
  rememberKeyOrData: string | TForm | (() => TForm),
  maybeData?: TForm | (() => TForm),
): Writable<InertiaForm<TForm>> {
  const rememberKey = typeof rememberKeyOrData === 'string' ? rememberKeyOrData : null
  const inputData = (typeof rememberKeyOrData === 'string' ? maybeData : rememberKeyOrData) ?? {}
  const data: TForm = typeof inputData === 'function' ? inputData() : (inputData as TForm)
  const restored = rememberKey
    ? (router.restore(rememberKey) as { data: TForm; errors: Record<FormDataKeys<TForm>, string> } | null)
    : null
  let defaults = cloneDeep(data)
  let cancelToken: { cancel: () => void } | null = null
  let recentlySuccessfulTimeoutId: ReturnType<typeof setTimeout> | null = null
  let transform = (data: TForm) => data as object

  const store = writable<InertiaForm<TForm>>({
    ...(restored ? restored.data : data),
    isDirty: false,
    errors: restored ? restored.errors : {},
    hasErrors: false,
    progress: null,
    wasSuccessful: false,
    recentlySuccessful: false,
    processing: false,
    setStore(keyOrData, maybeValue = undefined) {
      store.update((store) => {
        return typeof keyOrData === 'string' ? set(store, keyOrData, maybeValue) : Object.assign(store, keyOrData)
      })
    },
    data() {
      return Object.keys(data).reduce((carry, key) => {
        return set(carry, key, get(this, key))
      }, {} as FormDataType) as TForm
    },
    transform(callback) {
      transform = callback
      return this
    },
    defaults(fieldOrFields?: FormDataKeys<TForm> | Partial<TForm>, maybeValue?: FormDataConvertible) {
      if (typeof fieldOrFields === 'undefined') {
        defaults = cloneDeep(this.data())
      } else {
        defaults =
          typeof fieldOrFields === 'string'
            ? set(cloneDeep(defaults), fieldOrFields, maybeValue)
            : Object.assign(cloneDeep(defaults), fieldOrFields)
      }

      return this
    },
    reset(...fields) {
      const clonedData = cloneDeep(defaults)
      if (fields.length === 0) {
        this.setStore(clonedData)
      } else {
        this.setStore(
          (fields as Array<FormDataKeys<TForm>>)
            .filter((key) => has(clonedData, key))
            .reduce((carry, key) => {
              return set(carry, key, get(clonedData, key))
            }, {} as FormDataType) as TForm,
        )
      }

      return this
    },
    setError(fieldOrFields: FormDataKeys<TForm> | Errors, maybeValue?: string) {
      this.setStore('errors', {
        ...this.errors,
        ...((typeof fieldOrFields === 'string' ? { [fieldOrFields]: maybeValue } : fieldOrFields) as Errors),
      })

      return this
    },
    clearErrors(...fields) {
      this.setStore(
        'errors',
        (Object.keys(this.errors) as FormDataKeys<TForm>[]).reduce(
          (carry, field) => ({
            ...carry,
            ...(fields.length > 0 && !fields.includes(field) ? { [field]: this.errors[field] } : {}),
          }),
          {},
        ) as Errors,
      )
      return this
    },
    resetAndClearErrors(...fields) {
      this.reset(...fields)
      this.clearErrors(...fields)
      return this
    },
    submit(...args) {
      const objectPassed = typeof args[0] === 'object'

      const method = objectPassed ? args[0].method : args[0]
      const url = objectPassed ? args[0].url : args[1]
      const options = (objectPassed ? args[1] : args[2]) ?? {}
      const data = transform(this.data()) as RequestPayload

      const _options: Omit<VisitOptions, 'method'> = {
        ...options,
        onCancelToken: (token: { cancel: () => void }) => {
          cancelToken = token

          if (options.onCancelToken) {
            return options.onCancelToken(token)
          }
        },
        onBefore: (visit: PendingVisit) => {
          this.setStore('wasSuccessful', false)
          this.setStore('recentlySuccessful', false)
          if (recentlySuccessfulTimeoutId) {
            clearTimeout(recentlySuccessfulTimeoutId)
          }

          if (options.onBefore) {
            return options.onBefore(visit)
          }
        },
        onStart: (visit: PendingVisit) => {
          this.setStore('processing', true)

          if (options.onStart) {
            return options.onStart(visit)
          }
        },
        onProgress: (event?: AxiosProgressEvent) => {
          this.setStore('progress', event as any)

          if (options.onProgress) {
            return options.onProgress(event)
          }
        },
        onSuccess: async (page: Page) => {
          this.setStore('processing', false)
          this.setStore('progress', null)
          this.clearErrors()
          this.setStore('wasSuccessful', true)
          this.setStore('recentlySuccessful', true)
          recentlySuccessfulTimeoutId = setTimeout(() => this.setStore('recentlySuccessful', false), 2000)

          const onSuccess = options.onSuccess ? await options.onSuccess(page) : null
          this.defaults(cloneDeep(this.data()))
          return onSuccess
        },
        onError: (errors: Errors) => {
          this.setStore('processing', false)
          this.setStore('progress', null)
          this.clearErrors().setError(errors)

          if (options.onError) {
            return options.onError(errors)
          }
        },
        onCancel: () => {
          this.setStore('processing', false)
          this.setStore('progress', null)

          if (options.onCancel) {
            return options.onCancel()
          }
        },
        onFinish: (visit: ActiveVisit) => {
          this.setStore('processing', false)
          this.setStore('progress', null)
          cancelToken = null

          if (options.onFinish) {
            return options.onFinish(visit)
          }
        },
      }

      if (method === 'delete') {
        router.delete(url, { ..._options, data })
      } else {
        router[method](url, data, _options)
      }
    },
    get(url, options) {
      this.submit('get', url, options)
    },
    post(url, options) {
      this.submit('post', url, options)
    },
    put(url, options) {
      this.submit('put', url, options)
    },
    patch(url, options) {
      this.submit('patch', url, options)
    },
    delete(url, options) {
      this.submit('delete', url, options)
    },
    cancel() {
      cancelToken?.cancel()
    },
  } as InertiaForm<TForm>)

  store.subscribe((form) => {
    if (form.isDirty === isEqual(form.data(), defaults)) {
      form.setStore('isDirty', !form.isDirty)
    }

    const hasErrors = Object.keys(form.errors).length > 0
    if (form.hasErrors !== hasErrors) {
      form.setStore('hasErrors', !form.hasErrors)
    }

    if (rememberKey) {
      router.remember({ data: form.data(), errors: form.errors }, rememberKey)
    }
  })

  return store
}
