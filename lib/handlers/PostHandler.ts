import debug from 'debug'

import BaseHandler from './BaseHandler'
import Upload from '../models/Upload'
import Uid from '../models/Uid'
import RequestValidator from '../validators/RequestValidator'
import {EVENTS, ERRORS} from '../constants'

import type http from 'node:http'
import type {DataStore, ServerOptions} from '../../types'
import type {SetRequired} from 'type-fest'

const log = debug('tus-node-server:handlers:post')

export default class PostHandler extends BaseHandler {
  // Overriding the `BaseHandler` type. We always set `namingFunction` in the constructor.
  options!: SetRequired<ServerOptions, 'namingFunction'>

  constructor(store: DataStore, options: ServerOptions) {
    if (options.namingFunction && typeof options.namingFunction !== 'function') {
      throw new Error("'namingFunction' must be a function")
    }

    if (!options.namingFunction) {
      options.namingFunction = Uid.rand
    }

    super(store, options)
  }

  /**
   * Create a file in the DataStore.
   */
  async send(req: http.IncomingMessage, res: http.ServerResponse) {
    if ('upload-concat' in req.headers && !this.store.hasExtension('concatentation')) {
      throw ERRORS.UNSUPPORTED_CONCATENATION_EXTENSION
    }

    const upload_length = req.headers['upload-length'] as string | undefined
    const upload_defer_length = req.headers['upload-defer-length'] as string | undefined
    const upload_metadata = req.headers['upload-metadata'] as string | undefined

    if (
      upload_defer_length !== undefined && // Throw error if extension is not supported
      !this.store.hasExtension('creation-defer-length')
    ) {
      throw ERRORS.UNSUPPORTED_CREATION_DEFER_LENGTH_EXTENSION
    }

    if ((upload_length === undefined) === (upload_defer_length === undefined)) {
      throw ERRORS.INVALID_LENGTH
    }

    let id

    try {
      id = this.options.namingFunction(req)
    } catch (error) {
      log('create: check your `namingFunction`. Error', error)
      throw ERRORS.FILE_WRITE_ERROR
    }

    const file = new Upload({
      id,
      size: upload_length ? Number.parseInt(upload_length, 10) : undefined,
      offset: 0,
      metadata: upload_metadata,
    })

    const obj = await this.store.create(file)
    this.emit(EVENTS.EVENT_FILE_CREATED, {file: obj})

    const url = this.generateUrl(req, file.id)
    this.emit(EVENTS.EVENT_ENDPOINT_CREATED, {url})

    const optional_headers: {
      'Upload-Offset'?: string
      'Upload-Expires'?: string
    } = {}

    // The request MIGHT include a Content-Type header when using creation-with-upload extension
    if (!RequestValidator.isInvalidHeader('content-type', req.headers['content-type'])) {
      const new_offset = await this.store.write(req, file.id, 0)
      optional_headers['Upload-Offset'] = new_offset.toString()

      if (new_offset === Number.parseInt(upload_length as string, 10)) {
        this.emit(EVENTS.EVENT_UPLOAD_COMPLETE, {file})
      }
    }

    // The Upload-Expires response header indicates the time after which the unfinished upload expires.
    // If expiration is known at creation time, Upload-Expires header MUST be included in the response
    if (
      this.store.hasExtension('expiration') &&
      this.store.getExpiration() > 0 &&
      file.creation_date
    ) {
      const created = await this.store.getUpload(file.id)
      if (created.offset !== Number.parseInt(upload_length as string, 10)) {
        const creation = new Date(file.creation_date)
        // Value MUST be in RFC 7231 datetime format
        optional_headers['Upload-Expires'] = new Date(
          creation.getTime() + this.store.getExpiration()
        ).toUTCString()
      }
    }

    return this.write(res, 201, {Location: url, ...optional_headers})
  }
}
